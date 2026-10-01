import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { leaveRequests, type LeaveStatus } from '../../db/schema/leave';
import { roles } from '../../db/schema/roles';
import { tasks } from '../../db/schema/tasks';
import { tenants } from '../../db/schema/tenants';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { AttendanceService, isRealDay, localParts } from '../attendance/attendance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppService } from '../../services/whatsapp.service';
import { WhatsAppBotsService } from '../whatsapp-bots/whatsapp-bots.service';
import { formatWorkId } from '../tasks/tasks.service';
import { formatDueLabel } from '../calendar/task-schedule';
import { maskPhone } from '../../lib/phone';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Leave requests.
 *   Employee        → the person they report to (or any Project Manager when none is set) → an Admin → approved
 *   Project Manager → an Admin → approved
 *   Admin           → another Admin → approved (approved at once when there is no other Admin)
 * An Admin's approval is final at either step. A rejection needs a comment and ends the request. A request the
 * manager hasn't decided within LEAVE_ESCALATION_HOURS goes to the Admins. Approved leave is written to attendance.
 */

type Request = typeof leaveRequests.$inferSelect;
type Tier = 'admin' | 'manager' | 'employee';

export class LeaveError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

interface Member {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  reportsTo: string | null;
  roleName: string;
  tier: Tier;
  canSeeAll: boolean;
}

const PENDING: LeaveStatus[] = ['pending_manager', 'pending_admin'];
const FINISHED_TASK_STATUSES = ['done', 'completed', 'cancelled'];
const MAX_DAYS_BACK = 31;
const MAX_SPAN_DAYS = 62;

const fullName = (m: { firstName: string; lastName: string }) => `${m.firstName} ${m.lastName}`.trim();

const tierOf = (roleName: string, permissions: Record<string, boolean>): Tier =>
  roleName === 'Admin' || permissions.admin === true ? 'admin' : permissions['leave.approve'] === true ? 'manager' : 'employee';

const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "Mon, 5 Oct – Wed, 7 Oct (3 days)" · "Mon, 5 Oct (first half)" */
export function datesLabel(r: { fromDay: string; toDay: string; halfDay: string | null; days: number }): string {
  if (r.halfDay) return `${dayLabel(r.fromDay)} (${r.halfDay} half)`;
  const span = r.fromDay === r.toDay ? dayLabel(r.fromDay) : `${dayLabel(r.fromDay)} – ${dayLabel(r.toDay)}`;
  return `${span} (${r.days} ${r.days === 1 ? 'day' : 'days'})`;
}

export class LeaveService {
  // ─── Members ──────────────────────────────────────────────────────────────────

  private static async members(tenantId: string): Promise<Member[]> {
    const rows = await withTenant<{ id: string; firstName: string; lastName: string; phone: string | null; reportsTo: string | null; roleName: string; permissions: Record<string, boolean> }[]>(
      tenantId,
      (tx) =>
        tx
          .select({
            id: users.id, firstName: users.firstName, lastName: users.lastName, phone: users.phone,
            reportsTo: users.reportsTo, roleName: roles.name, permissions: roles.permissions,
          })
          .from(users)
          .innerJoin(roles, eq(roles.id, users.roleId))
          .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt))),
    );
    return rows.map((r) => {
      const permissions = r.permissions ?? {};
      const tier = tierOf(r.roleName, permissions);
      return {
        id: r.id, firstName: r.firstName, lastName: r.lastName, phone: r.phone, reportsTo: r.reportsTo, roleName: r.roleName, tier,
        canSeeAll: tier !== 'employee' || permissions['attendance.read'] === true,
      };
    });
  }

  private static member(members: Member[], id: string): Member {
    const m = members.find((x) => x.id === id);
    if (!m) throw new LeaveError(403, 'not_a_member', 'You are not a member of this workspace');
    return m;
  }

  /** Who decides a request now */
  private static approvers(request: Pick<Request, 'status' | 'userId' | 'managerId'>, members: Member[]): Member[] {
    const others = members.filter((m) => m.id !== request.userId);
    if (request.status === 'pending_admin') return others.filter((m) => m.tier === 'admin');
    if (request.status !== 'pending_manager') return [];
    if (request.managerId) return others.filter((m) => m.id === request.managerId);
    return others.filter((m) => m.tier === 'manager');
  }

  /** Whether someone may approve or reject a request now (Admins may decide either step) */
  private static canDecide(request: Request, actor: Member): boolean {
    if (actor.id === request.userId || !PENDING.includes(request.status)) return false;
    if (actor.tier === 'admin') return true;
    if (request.status !== 'pending_manager') return false;
    return request.managerId ? request.managerId === actor.id : actor.tier === 'manager';
  }

  // ─── Applying ─────────────────────────────────────────────────────────────────

  static async apply(tenantId: string, userId: string, input: { from: string; to: string; halfDay?: 'first' | 'second' | null; reason: string }) {
    const { from, to, reason } = input;
    const halfDay = input.halfDay ?? null;
    if (!isRealDay(from) || !isRealDay(to)) throw new LeaveError(400, 'invalid_date', 'Choose valid dates');
    if (to < from) throw new LeaveError(400, 'invalid_range', 'The end date is before the start date');
    if (halfDay && from !== to) throw new LeaveError(400, 'half_day_range', 'A half day is for one date only');
    const today = localParts(new Date()).day;
    if (from < addDays(today, -MAX_DAYS_BACK)) throw new LeaveError(400, 'too_far_back', `Leave can be applied for at most ${MAX_DAYS_BACK} days back`);
    if (to > addDays(today, 366)) throw new LeaveError(400, 'too_far_ahead', 'Leave can be applied for at most a year ahead');
    if (to > addDays(from, MAX_SPAN_DAYS)) throw new LeaveError(400, 'range_too_long', 'One request can cover at most about two months');

    const workingDays = await AttendanceService.workingDays(tenantId, from, to);
    if (!workingDays.length) throw new LeaveError(400, 'no_working_days', 'These dates have no working days (days off or holidays)');
    const days = halfDay ? 0.5 : workingDays.length;

    const [overlap] = await db
      .select({ id: leaveRequests.id })
      .from(leaveRequests)
      .where(and(
        eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.userId, userId),
        inArray(leaveRequests.status, [...PENDING, 'approved']),
        lte(leaveRequests.fromDay, to), gte(leaveRequests.toDay, from),
      ))
      .limit(1);
    if (overlap) throw new LeaveError(409, 'overlap', 'You already have leave applied for some of these dates');

    const members = await this.members(tenantId);
    const me = this.member(members, userId);
    const others = members.filter((m) => m.id !== userId);
    const manager = me.reportsTo ? others.find((m) => m.id === me.reportsTo) : undefined;
    const hasManagers = others.some((m) => m.tier === 'manager');
    const hasOtherAdmins = others.some((m) => m.tier === 'admin');

    let status: LeaveStatus;
    if (me.tier === 'employee' && (manager || hasManagers)) status = 'pending_manager';
    else if (hasOtherAdmins) status = 'pending_admin';
    else status = 'approved'; // nobody else can decide (e.g. the only Admin)

    const now = new Date();
    const [request] = await db
      .insert(leaveRequests)
      .values({
        tenantId, userId, fromDay: from, toDay: to, halfDay, reason, status, days,
        managerId: status === 'pending_manager' ? manager?.id ?? null : null,
        ...(status === 'approved' ? { adminAt: now, adminComment: 'Approved automatically: no one else can approve' } : {}),
      })
      .returning();
    logger.info({ tenantId, userId, requestId: request.id, status, days }, '[Leave] Applied');

    if (status === 'approved') {
      await AttendanceService.applyLeaveRequest(tenantId, userId, request);
    } else {
      this.notifyApprovers(tenantId, request, members, me).catch((err) => logger.error({ err }, '[Leave] Notifying approvers failed'));
    }
    return this.withNames(request, members);
  }

  // ─── Deciding ─────────────────────────────────────────────────────────────────

  static async decide(tenantId: string, actorId: string, id: string, decision: 'approve' | 'reject', comment?: string | null) {
    const members = await this.members(tenantId);
    const actor = this.member(members, actorId);
    const request = await this.get(tenantId, id);
    if (!this.canDecide(request, actor)) {
      throw new LeaveError(PENDING.includes(request.status) ? 403 : 409, 'cannot_decide',
        PENDING.includes(request.status) ? 'You cannot decide this request' : 'This request has already been decided');
    }
    const note = comment?.trim() || null;
    if (decision === 'reject' && (!note || note.length < 2)) throw new LeaveError(400, 'comment_required', 'Add a comment to reject');

    const now = new Date();
    const managerStep = request.status === 'pending_manager';
    const step = managerStep && actor.tier !== 'admin'
      ? { managerBy: actorId, managerAt: now, managerComment: note }
      : { adminBy: actorId, adminAt: now, adminComment: note };

    let next: LeaveStatus;
    if (decision === 'reject') next = 'rejected';
    else if (actor.tier === 'admin') next = 'approved';
    else next = members.some((m) => m.tier === 'admin' && m.id !== request.userId) ? 'pending_admin' : 'approved';

    const [updated] = await db
      .update(leaveRequests)
      .set({ ...step, status: next, updatedAt: now })
      .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.status, request.status)))
      .returning();
    if (!updated) throw new LeaveError(409, 'changed', 'This request was changed by someone else. Refresh and try again.');
    logger.info({ tenantId, requestId: id, by: actorId, from: request.status, to: next }, '[Leave] Decided');

    if (next === 'approved') await AttendanceService.applyLeaveRequest(tenantId, actorId, updated);

    const applicant = members.find((m) => m.id === request.userId);
    if (applicant) {
      const what = next === 'approved' ? `approved by ${fullName(actor)}`
        : next === 'rejected' ? `rejected by ${fullName(actor)}${note ? `: ${note}` : ''}`
        : `approved by ${fullName(actor)} and is now waiting for an Admin`;
      this.notifyApplicant(tenantId, updated, applicant, what, actorId).catch((err) => logger.error({ err }, '[Leave] Notifying applicant failed'));
      if (next === 'pending_admin') {
        this.notifyApprovers(tenantId, updated, members, applicant).catch((err) => logger.error({ err }, '[Leave] Notifying admins failed'));
      }
    }
    return this.withNames(updated, members);
  }

  /** The applicant withdraws a request; an approved one only before it starts. Admins may cancel approved leave. */
  static async cancel(tenantId: string, actorId: string, id: string) {
    const members = await this.members(tenantId);
    const actor = this.member(members, actorId);
    const request = await this.get(tenantId, id);
    const own = request.userId === actorId;
    const today = localParts(new Date()).day;

    if (PENDING.includes(request.status)) {
      if (!own) throw new LeaveError(403, 'not_yours', 'Only the person who applied can withdraw a pending request');
    } else if (request.status === 'approved') {
      if (!(actor.tier === 'admin' || (own && request.fromDay > today))) {
        throw new LeaveError(403, 'already_started', 'Leave that has started can only be cancelled by an Admin');
      }
    } else {
      throw new LeaveError(409, 'closed', 'This request is already closed');
    }

    const now = new Date();
    const [updated] = await db
      .update(leaveRequests)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.status, request.status)))
      .returning();
    if (!updated) throw new LeaveError(409, 'changed', 'This request was changed by someone else. Refresh and try again.');
    if (request.status === 'approved') await AttendanceService.removeLeaveRequest(tenantId, id);
    logger.info({ tenantId, requestId: id, by: actorId, was: request.status }, '[Leave] Cancelled');

    const applicant = members.find((m) => m.id === request.userId);
    if (applicant && !own) {
      this.notifyApplicant(tenantId, updated, applicant, `cancelled by ${fullName(actor)}`, actorId).catch(() => undefined);
    }
    // Tell whoever approved it that the approved leave is off
    if (request.status === 'approved' && own) {
      const deciders = [...new Set([request.managerBy, request.adminBy].filter((x): x is string => !!x && x !== actorId))];
      for (const recipientUserId of deciders) {
        await withTenant(tenantId, (tx) => NotificationsService.notify({
          tenantId, recipientUserId, actorUserId: actorId, type: 'leave_update', entityType: 'leave', entityId: id,
          title: `${fullName(actor)} cancelled their leave`, message: datesLabel(updated),
        }, tx)).catch(() => undefined);
      }
    }
    return this.withNames(updated, members);
  }

  // ─── Lists ────────────────────────────────────────────────────────────────────

  private static async get(tenantId: string, id: string): Promise<Request> {
    const [request] = await db.select().from(leaveRequests).where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenantId))).limit(1);
    if (!request) throw new LeaveError(404, 'not_found', 'Leave request not found');
    return request;
  }

  private static withNames(r: Request, members: Member[]) {
    const name = (id: string | null) => {
      const m = id ? members.find((x) => x.id === id) : undefined;
      return m ? fullName(m) : null;
    };
    return {
      ...r,
      userName: name(r.userId) ?? 'Former member',
      managerName: name(r.managerId),
      managerByName: name(r.managerBy),
      adminByName: name(r.adminBy),
      waitingFor: r.status === 'pending_manager' ? (name(r.managerId) ?? 'a Project Manager') : r.status === 'pending_admin' ? 'an Admin' : null,
    };
  }

  /** The signed-in person's own requests, newest first */
  static async mine(tenantId: string, userId: string) {
    const [members, rows] = await Promise.all([
      this.members(tenantId),
      db.select().from(leaveRequests)
        .where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.userId, userId)))
        .orderBy(desc(leaveRequests.createdAt)).limit(100),
    ]);
    return rows.map((r) => this.withNames(r, members));
  }

  /** Requests the signed-in person can approve or reject now, with what the approver should know */
  static async inbox(tenantId: string, actorId: string) {
    const members = await this.members(tenantId);
    const actor = this.member(members, actorId);
    if (actor.tier === 'employee' && !members.some((m) => m.reportsTo === actorId)) return [];
    const pending = await db.select().from(leaveRequests)
      .where(and(eq(leaveRequests.tenantId, tenantId), inArray(leaveRequests.status, PENDING)))
      .orderBy(leaveRequests.fromDay);
    const mine = pending.filter((r) => this.canDecide(r, actor));
    return Promise.all(mine.map(async (r) => ({ ...this.withNames(r, members), clashes: await this.clashes(tenantId, r, members) })));
  }

  /** Everyone's requests that touch a month (plus everything still pending), for Admins and Project Managers */
  static async all(tenantId: string, actorId: string, month: string) {
    const members = await this.members(tenantId);
    if (!this.member(members, actorId).canSeeAll) throw new LeaveError(403, 'forbidden', 'Insufficient permissions');
    const from = `${month}-01`;
    const to = addDays(addDays(from, 31).slice(0, 8) + '01', -1);
    const rows = await db.select().from(leaveRequests)
      .where(and(
        eq(leaveRequests.tenantId, tenantId),
        or(inArray(leaveRequests.status, PENDING), and(lte(leaveRequests.fromDay, to), gte(leaveRequests.toDay, from))),
      ))
      .orderBy(desc(leaveRequests.fromDay)).limit(500);
    return rows.map((r) => this.withNames(r, members));
  }

  /** Who else is away on those days, and the applicant's work that is due then */
  private static async clashes(tenantId: string, r: Request, members: Member[]) {
    const away = await db.select().from(leaveRequests)
      .where(and(
        eq(leaveRequests.tenantId, tenantId), ne(leaveRequests.userId, r.userId),
        inArray(leaveRequests.status, [...PENDING, 'approved']),
        lte(leaveRequests.fromDay, r.toDay), gte(leaveRequests.toDay, r.fromDay),
      ))
      .orderBy(leaveRequests.fromDay).limit(20);

    // due_at is a moment; compare its local day with the leave days (fetch a day either side, then filter)
    const due = await withTenant<{ taskNumber: number | null; name: string; customFields: unknown; dueAt: Date | null }[]>(tenantId, (tx) =>
      tx.select({ taskNumber: tasks.taskNumber, name: tasks.name, customFields: tasks.customFields, dueAt: tasks.dueAt })
        .from(tasks)
        .where(and(
          eq(tasks.tenantId, tenantId), eq(tasks.assigneeId, r.userId), isNull(tasks.deletedAt),
          notInArray(tasks.status, FINISHED_TASK_STATUSES),
          gte(tasks.dueAt, new Date(`${addDays(r.fromDay, -1)}T00:00:00Z`)),
          lt(tasks.dueAt, new Date(`${addDays(r.toDay, 2)}T00:00:00Z`)),
        ))
        .orderBy(tasks.dueAt).limit(50),
    );
    return {
      othersAway: away.map((a) => ({
        name: members.find((m) => m.id === a.userId) ? fullName(members.find((m) => m.id === a.userId)!) : 'Former member',
        fromDay: a.fromDay, toDay: a.toDay, halfDay: a.halfDay, status: a.status,
      })),
      dueWork: due
        .filter((t) => t.dueAt && localParts(t.dueAt).day >= r.fromDay && localParts(t.dueAt).day <= r.toDay)
        .map((t) => ({ workId: formatWorkId(t.taskNumber), name: t.name, due: formatDueLabel(t.customFields) })),
    };
  }

  // ─── Reports to ───────────────────────────────────────────────────────────────

  static async team(tenantId: string, actorId: string) {
    const members = await this.members(tenantId);
    if (this.member(members, actorId).tier !== 'admin') throw new LeaveError(403, 'forbidden', 'Only Admins can set who people report to');
    return members
      .map((m) => ({ id: m.id, name: fullName(m), role: m.roleName, tier: m.tier, reportsTo: m.reportsTo }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  static async setReportsTo(tenantId: string, actorId: string, userId: string, reportsTo: string | null) {
    const members = await this.members(tenantId);
    if (this.member(members, actorId).tier !== 'admin') throw new LeaveError(403, 'forbidden', 'Only Admins can set who people report to');
    if (!members.some((m) => m.id === userId)) throw new LeaveError(404, 'member_not_found', 'This member is not in your workspace');
    if (reportsTo) {
      if (reportsTo === userId) throw new LeaveError(400, 'self', 'A person cannot report to themselves');
      if (!members.some((m) => m.id === reportsTo)) throw new LeaveError(404, 'member_not_found', 'This member is not in your workspace');
    }
    await withTenant(tenantId, (tx) =>
      tx.update(users).set({ reportsTo, updatedAt: new Date() }).where(and(eq(users.id, userId), eq(users.tenantId, tenantId))),
    );
    return { userId, reportsTo };
  }

  // ─── Escalation ───────────────────────────────────────────────────────────────

  /** Sends requests their manager hasn't decided in time to the Admins */
  static async escalateOverdue(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - env.LEAVE_ESCALATION_HOURS * 3600_000);
    const moved = await db
      .update(leaveRequests)
      .set({ status: 'pending_admin', escalatedAt: now, updatedAt: now })
      .where(and(eq(leaveRequests.status, 'pending_manager'), lt(leaveRequests.createdAt, cutoff)))
      .returning();
    for (const request of moved) {
      try {
        const [tenant] = await db.select({ isActive: tenants.isActive }).from(tenants).where(eq(tenants.id, request.tenantId)).limit(1);
        if (!tenant?.isActive) continue;
        const members = await this.members(request.tenantId);
        const applicant = members.find((m) => m.id === request.userId);
        if (!applicant) continue;
        if (!members.some((m) => m.tier === 'admin' && m.id !== request.userId)) {
          // No Admin to send it to: approve it as the workspace has nobody else to decide
          const [approved] = await db.update(leaveRequests)
            .set({ status: 'approved', adminAt: now, adminComment: 'Approved automatically: no Admin to decide', updatedAt: now })
            .where(and(eq(leaveRequests.id, request.id), eq(leaveRequests.status, 'pending_admin')))
            .returning();
          if (approved) await AttendanceService.applyLeaveRequest(request.tenantId, request.userId, approved);
          continue;
        }
        logger.info({ tenantId: request.tenantId, requestId: request.id }, '[Leave] Escalated to Admins');
        await this.notifyApprovers(request.tenantId, request, members, applicant, true);
      } catch (err) {
        logger.error({ err, requestId: request.id }, '[Leave] Escalation follow-up failed');
      }
    }
    return moved.length;
  }

  // ─── Notifications ────────────────────────────────────────────────────────────

  private static async notifyApprovers(tenantId: string, request: Request, members: Member[], applicant: Member, escalated = false) {
    const approvers = this.approvers(request, members);
    if (!approvers.length) return;
    const dates = datesLabel(request);
    const title = escalated
      ? `Leave request waiting ${env.LEAVE_ESCALATION_HOURS} h: ${fullName(applicant)}`
      : `Leave request from ${fullName(applicant)}`;
    await withTenant(tenantId, async (tx) => {
      for (const a of approvers) {
        await NotificationsService.notify({
          tenantId, recipientUserId: a.id, actorUserId: applicant.id, type: 'leave_request', entityType: 'leave', entityId: request.id,
          title, message: `${dates} · ${request.reason}`, priority: 'warning',
        }, tx);
      }
    });
    const wa = await WhatsAppBotsService.forTenant(tenantId);
    for (const a of approvers) {
      if (!a.phone) continue;
      const sent = await WhatsAppService.sendBodyTemplate(
        a.phone, env.WHATSAPP_LEAVE_REQUEST_TEMPLATE, wa.templates.lang, [a.firstName, fullName(applicant), dates, request.reason], wa.sender,
      );
      if (!sent.success) logger.warn({ to: maskPhone(a.phone), error: sent.error }, '[Leave] WhatsApp to approver failed');
    }
  }

  private static async notifyApplicant(tenantId: string, request: Request, applicant: Member, what: string, actorId: string) {
    const dates = datesLabel(request);
    await withTenant(tenantId, (tx) => NotificationsService.notify({
      tenantId, recipientUserId: applicant.id, actorUserId: actorId, type: 'leave_update', entityType: 'leave', entityId: request.id,
      title: request.status === 'pending_admin' ? 'Your leave was approved by your manager' : `Your leave was ${request.status}`,
      message: `${dates} · ${what}`,
      priority: request.status === 'rejected' ? 'warning' : 'info',
    }, tx));
    if (!applicant.phone) return;
    const wa = await WhatsAppBotsService.forTenant(tenantId);
    const sent = await WhatsAppService.sendBodyTemplate(
      applicant.phone, env.WHATSAPP_LEAVE_UPDATE_TEMPLATE, wa.templates.lang, [applicant.firstName, dates, what], wa.sender,
    );
    if (!sent.success) logger.warn({ to: maskPhone(applicant.phone), error: sent.error }, '[Leave] WhatsApp to applicant failed');
  }
}

/** Every 5 minutes in the API process (with the task reminders; off when TASK_REMINDERS_ENABLED=false) */
export function startLeaveEscalation() {
  if (env.TASK_REMINDERS_ENABLED === 'false') return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await LeaveService.escalateOverdue();
    } catch (err) {
      logger.error({ err }, '[Leave] Escalation check failed');
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 20_000);
  setInterval(tick, 5 * 60_000);
  logger.info(`[Leave] Requests undecided for ${env.LEAVE_ESCALATION_HOURS} h go to the Admins (checked every 5 minutes)`);
}
