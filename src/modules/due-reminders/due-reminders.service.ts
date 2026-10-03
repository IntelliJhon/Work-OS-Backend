import { randomUUID } from 'crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { dueReminders, type ReminderRepeat } from '../../db/schema/due_reminders';
import { roles } from '../../db/schema/roles';
import { tenants } from '../../db/schema/tenants';
import { uploads } from '../../db/schema/uploads';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { isRealDay, localParts } from '../attendance/attendance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SectionsService } from '../sections/sections.service';
import { UploadService } from '../uploads/upload.service';
import { WhatsAppService } from '../../services/whatsapp.service';
import { WhatsAppBotsService } from '../whatsapp-bots/whatsapp-bots.service';
import { maskPhone } from '../../lib/phone';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Reminders for bills, renewals, subscriptions, taxes…
 *   WhatsApp + in-app: 10:00 the day before the due date, then every 12 hours until it is marked done.
 *   Quiet hours 21:00–08:00 (local): a reminder that would fall then is sent at 08:00.
 *   Done = a report and at least one proof file (image or PDF). A repeating reminder then gets its next occurrence.
 *   Once the due date has passed, the Admins are told (once).
 *   Visible to the person responsible, the person who created it, and Admins.
 */

type Row = typeof dueReminders.$inferSelect;
export const CATEGORIES = ['bill', 'renewal', 'subscription', 'tax', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export class ReminderError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const REPEAT_HOURS = 12;
const FIRST_AT = '10:00';
const QUIET_FROM = '21:00';
const QUIET_UNTIL = '08:00';
const PROOF_TYPES = /^(image\/(png|jpe?g|gif|webp|heic|heif)|application\/pdf)$/i;

// ─── Dates ──────────────────────────────────────────────────────────────────────

const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The same day-of-month (or the month's last day) n months later */
function addMonths(day: string, n: number, anchorDay: number) {
  const [y, m] = day.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(anchorDay, dim)).padStart(2, '0')}`;
}

/** A local day + time as a moment */
export function atLocal(day: string, hhmm: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: env.WORK_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const shownAsLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (shownAsLocal - guess));
}

/** Moves a moment out of quiet hours (to 08:00) */
export function outOfQuietHours(t: Date): Date {
  const { day, hhmm } = localParts(t);
  if (hhmm >= QUIET_FROM) return atLocal(addDays(day, 1), QUIET_UNTIL);
  if (hhmm < QUIET_UNTIL) return atLocal(day, QUIET_UNTIL);
  return t;
}

/** When the first reminder for a due date goes out (now, if that time has passed) */
export function firstNotifyAt(dueDate: string, now: Date): Date {
  const planned = atLocal(addDays(dueDate, -1), FIRST_AT);
  return outOfQuietHours(planned > now ? planned : now);
}

export const nextRepeatAt = (now: Date) => outOfQuietHours(new Date(now.getTime() + REPEAT_HOURS * 3600_000));

/** The next due date of a repeating reminder */
export function nextDueDate(r: Pick<Row, 'repeat' | 'everyN' | 'everyUnit' | 'anchorDate' | 'dueDate'>): string | null {
  const anchorDay = Number(r.anchorDate.slice(8, 10));
  if (r.repeat === 'monthly') return addMonths(r.dueDate, 1, anchorDay);
  if (r.repeat === 'yearly') return addMonths(r.dueDate, 12, anchorDay);
  if (r.repeat === 'custom' && r.everyN) {
    if (r.everyUnit === 'day') return addDays(r.dueDate, r.everyN);
    if (r.everyUnit === 'week') return addDays(r.dueDate, 7 * r.everyN);
    if (r.everyUnit === 'month') return addMonths(r.dueDate, r.everyN, anchorDay);
  }
  return null;
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "tomorrow, Fri, 2 Oct" · "today, Fri, 2 Oct" · "Fri, 2 Oct (overdue by 2 days)" */
export function dueLabel(dueDate: string, today: string): string {
  const diff = daysBetween(today, dueDate);
  if (diff === 0) return `today, ${dayLabel(dueDate)}`;
  if (diff === 1) return `tomorrow, ${dayLabel(dueDate)}`;
  if (diff < 0) return `${dayLabel(dueDate)} (overdue by ${-diff} day${diff === -1 ? '' : 's'})`;
  return dayLabel(dueDate);
}

export const amountLabel = (amount: string | null) =>
  amount === null || amount === undefined ? 'Not set' : Number(amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

// ─── People ─────────────────────────────────────────────────────────────────────

interface Member { id: string; firstName: string; lastName: string; phone: string | null; admin: boolean }
const fullName = (m: { firstName: string; lastName: string }) => `${m.firstName} ${m.lastName}`.trim();

async function membersOf(tenantId: string): Promise<Member[]> {
  const rows = await withTenant<{ id: string; firstName: string; lastName: string; phone: string | null; roleName: string; permissions: Record<string, boolean> }[]>(
    tenantId,
    (tx) => tx
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, phone: users.phone, roleName: roles.name, permissions: roles.permissions })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt))),
  );
  return rows.map((r) => ({ id: r.id, firstName: r.firstName, lastName: r.lastName, phone: r.phone, admin: r.roleName === 'Admin' || r.permissions?.admin === true }));
}

// ─── Service ────────────────────────────────────────────────────────────────────

export interface ReminderInput {
  title: string;
  notes?: string | null;
  category: Category;
  amount?: number | null;
  repeat: ReminderRepeat;
  everyN?: number | null;
  everyUnit?: 'day' | 'week' | 'month' | null;
  dueDate: string;
  ownerId?: string | null;
}

export class DueRemindersService {
  private static canSee(r: Row, actor: Member) {
    return actor.admin || r.ownerId === actor.id || r.createdBy === actor.id;
  }

  private static actorOf(members: Member[], actorId: string): Member {
    const actor = members.find((m) => m.id === actorId);
    if (!actor) throw new ReminderError(403, 'not_a_member', 'You are not a member of this workspace');
    return actor;
  }

  private static async row(tenantId: string, id: string): Promise<Row> {
    const [r] = await db.select().from(dueReminders).where(and(eq(dueReminders.id, id), eq(dueReminders.tenantId, tenantId))).limit(1);
    if (!r) throw new ReminderError(404, 'not_found', 'Reminder not found');
    return r;
  }

  private static view(r: Row, members: Member[], today: string) {
    const name = (id: string | null) => {
      const m = id ? members.find((x) => x.id === id) : undefined;
      return m ? fullName(m) : null;
    };
    return {
      ...r,
      amount: r.amount === null ? null : Number(r.amount),
      ownerName: name(r.ownerId) ?? 'Former member',
      createdByName: name(r.createdBy),
      completedByName: name(r.completedBy),
      overdue: r.status === 'active' && r.dueDate < today,
      dueInDays: daysBetween(today, r.dueDate),
    };
  }

  private static validate(input: ReminderInput, members: Member[]) {
    const title = input.title?.trim();
    if (!title || title.length < 2) throw new ReminderError(400, 'title', 'Give the reminder a title');
    if (!CATEGORIES.includes(input.category)) throw new ReminderError(400, 'category', 'Choose a category');
    if (!isRealDay(input.dueDate)) throw new ReminderError(400, 'due_date', 'Choose a valid due date');
    if (input.amount !== null && input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount < 0 || input.amount > 9_999_999_999)) {
      throw new ReminderError(400, 'amount', 'Enter a valid amount');
    }
    if (input.repeat === 'custom') {
      if (!input.everyN || input.everyN < 1 || input.everyN > 365) throw new ReminderError(400, 'every_n', 'Repeat every 1 to 365');
      if (!['day', 'week', 'month'].includes(input.everyUnit ?? '')) throw new ReminderError(400, 'every_unit', 'Choose days, weeks or months');
    }
    if (input.ownerId && !members.some((m) => m.id === input.ownerId)) throw new ReminderError(400, 'owner', 'That person is not in your workspace');
  }

  static async list(tenantId: string, actorId: string, scope: 'mine' | 'all') {
    const members = await membersOf(tenantId);
    const actor = this.actorOf(members, actorId);
    const today = localParts(new Date()).day;
    const everyone = scope === 'all' && actor.admin;
    const rows = await db
      .select()
      .from(dueReminders)
      .where(and(
        eq(dueReminders.tenantId, tenantId),
        ne(dueReminders.status, 'cancelled'),
        everyone ? sql`true` : or(eq(dueReminders.ownerId, actorId), eq(dueReminders.createdBy, actorId)),
        // Active ones, and what was done in the last year
        or(eq(dueReminders.status, 'active'), gte(dueReminders.completedAt, new Date(Date.now() - 366 * 86_400_000))),
      ))
      .orderBy(asc(dueReminders.dueDate))
      .limit(1000);
    return { reminders: rows.map((r) => this.view(r, members, today)), isAdmin: actor.admin, today };
  }

  static async get(tenantId: string, actorId: string, id: string) {
    const members = await membersOf(tenantId);
    const actor = this.actorOf(members, actorId);
    const r = await this.row(tenantId, id);
    if (!this.canSee(r, actor)) throw new ReminderError(404, 'not_found', 'Reminder not found');
    const today = localParts(new Date()).day;
    const history = await db
      .select()
      .from(dueReminders)
      .where(and(eq(dueReminders.tenantId, tenantId), eq(dueReminders.seriesId, r.seriesId), ne(dueReminders.id, r.id), ne(dueReminders.status, 'cancelled')))
      .orderBy(desc(dueReminders.dueDate))
      .limit(24);
    const ids = [r.id, ...history.map((h) => h.id)];
    const files = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
      tx.select().from(uploads).where(and(eq(uploads.tenantId, tenantId), eq(uploads.entityType, 'REMINDER'), inArray(uploads.entityId, ids))),
    );
    const proofsOf = (rid: string) => files
      .filter((f) => f.entityId === rid)
      .map((f) => ({ id: f.id, name: f.originalName, mimeType: f.mimeType, size: f.size, createdAt: f.createdAt }));
    return {
      ...this.view(r, members, today),
      proofs: proofsOf(r.id),
      history: history.map((h) => ({ ...this.view(h, members, today), proofs: proofsOf(h.id) })),
      canEdit: true,
      members: members.map((m) => ({ id: m.id, name: fullName(m) })),
    };
  }

  static async create(tenantId: string, actorId: string, input: ReminderInput) {
    const members = await membersOf(tenantId);
    this.actorOf(members, actorId);
    this.validate(input, members);
    const now = new Date();
    const [r] = await db
      .insert(dueReminders)
      .values({
        tenantId,
        seriesId: randomUUID(),
        ownerId: input.ownerId || actorId,
        createdBy: actorId,
        title: input.title.trim(),
        notes: input.notes?.trim() || null,
        category: input.category,
        amount: input.amount === null || input.amount === undefined ? null : String(input.amount),
        repeat: input.repeat,
        everyN: input.repeat === 'custom' ? input.everyN! : null,
        everyUnit: input.repeat === 'custom' ? input.everyUnit! : null,
        anchorDate: input.dueDate,
        dueDate: input.dueDate,
        nextNotifyAt: firstNotifyAt(input.dueDate, now),
      })
      .returning();
    logger.info({ tenantId, reminderId: r.id, due: r.dueDate, repeat: r.repeat }, '[DueReminders] Created');
    return this.view(r, members, localParts(now).day);
  }

  static async update(tenantId: string, actorId: string, id: string, input: ReminderInput) {
    const members = await membersOf(tenantId);
    const actor = this.actorOf(members, actorId);
    const r = await this.row(tenantId, id);
    if (!this.canSee(r, actor)) throw new ReminderError(404, 'not_found', 'Reminder not found');
    if (r.status !== 'active') throw new ReminderError(409, 'closed', 'This reminder is already done');
    this.validate(input, members);
    const now = new Date();
    const dueChanged = input.dueDate !== r.dueDate;
    const [updated] = await db
      .update(dueReminders)
      .set({
        title: input.title.trim(),
        notes: input.notes?.trim() || null,
        category: input.category,
        amount: input.amount === null || input.amount === undefined ? null : String(input.amount),
        repeat: input.repeat,
        everyN: input.repeat === 'custom' ? input.everyN! : null,
        everyUnit: input.repeat === 'custom' ? input.everyUnit! : null,
        ownerId: input.ownerId || r.ownerId || actorId,
        ...(dueChanged ? { dueDate: input.dueDate, anchorDate: input.dueDate, nextNotifyAt: firstNotifyAt(input.dueDate, now), escalatedAt: null, notifyCount: 0 } : {}),
        updatedAt: now,
      })
      .where(and(eq(dueReminders.id, id), eq(dueReminders.tenantId, tenantId)))
      .returning();
    return this.view(updated, members, localParts(now).day);
  }

  /** Stops a reminder (this occurrence; no next one is created) */
  static async cancel(tenantId: string, actorId: string, id: string) {
    const members = await membersOf(tenantId);
    const actor = this.actorOf(members, actorId);
    const r = await this.row(tenantId, id);
    if (!this.canSee(r, actor)) throw new ReminderError(404, 'not_found', 'Reminder not found');
    if (r.status !== 'active') throw new ReminderError(409, 'closed', 'This reminder is already done');
    await db.update(dueReminders).set({ status: 'cancelled', nextNotifyAt: null, updatedAt: new Date() }).where(eq(dueReminders.id, id));
    return { id };
  }

  /** Marks it done with a report and proof files; a repeating reminder gets its next occurrence */
  static async complete(tenantId: string, actorId: string, id: string, report: string, files: Express.Multer.File[]) {
    const members = await membersOf(tenantId);
    const actor = this.actorOf(members, actorId);
    const r = await this.row(tenantId, id);
    if (!this.canSee(r, actor)) throw new ReminderError(404, 'not_found', 'Reminder not found');
    if (r.status !== 'active') throw new ReminderError(409, 'closed', 'This reminder is already done');
    const text = report?.trim() ?? '';
    if (text.length < 2) throw new ReminderError(400, 'report', 'Write a short report of what was done');
    if (!files?.length) throw new ReminderError(400, 'proof', 'Attach at least one proof (photo or PDF)');
    const bad = files.find((f) => !PROOF_TYPES.test(f.mimetype));
    if (bad) throw new ReminderError(400, 'proof_type', `${bad.originalname}: only photos and PDFs can be attached`);

    for (const file of files) {
      await UploadService.processUpload({ tenantId, uploaderId: actorId, entityType: 'REMINDER', entityId: r.id, file });
    }
    const now = new Date();
    const [done] = await db
      .update(dueReminders)
      .set({ status: 'done', completedAt: now, completedBy: actorId, report: text, nextNotifyAt: null, updatedAt: now })
      .where(and(eq(dueReminders.id, id), eq(dueReminders.status, 'active')))
      .returning();
    if (!done) throw new ReminderError(409, 'closed', 'This reminder was just completed by someone else');

    let next: Row | undefined;
    const nextDue = nextDueDate(r);
    if (nextDue) {
      [next] = await db
        .insert(dueReminders)
        .values({
          tenantId, seriesId: r.seriesId, ownerId: r.ownerId, createdBy: r.createdBy, title: r.title, notes: r.notes,
          category: r.category, amount: r.amount, repeat: r.repeat, everyN: r.everyN, everyUnit: r.everyUnit,
          anchorDate: r.anchorDate, dueDate: nextDue, nextNotifyAt: firstNotifyAt(nextDue, now),
        })
        .returning();
    }
    logger.info({ tenantId, reminderId: id, by: actorId, next: next?.dueDate }, '[DueReminders] Done');
    const today = localParts(now).day;
    return { done: this.view(done, members, today), next: next ? this.view(next, members, today) : null };
  }

  /** A short-lived link to a proof file */
  static async proofUrl(tenantId: string, actorId: string, id: string, uploadId: string) {
    const members = await membersOf(tenantId);
    const actor = this.actorOf(members, actorId);
    const r = await this.row(tenantId, id);
    if (!this.canSee(r, actor)) throw new ReminderError(404, 'not_found', 'Reminder not found');
    const [file] = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
      tx.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.tenantId, tenantId), eq(uploads.entityType, 'REMINDER'))),
    );
    if (!file) throw new ReminderError(404, 'not_found', 'File not found');
    // The file must belong to this reminder or another occurrence of the same series
    const [owner] = await db.select({ seriesId: dueReminders.seriesId }).from(dueReminders).where(and(eq(dueReminders.id, file.entityId), eq(dueReminders.tenantId, tenantId)));
    if (!owner || owner.seriesId !== r.seriesId) throw new ReminderError(404, 'not_found', 'File not found');
    return { url: await UploadService.getSignedDownloadUrl(tenantId, uploadId) };
  }

  // ─── Sending ──────────────────────────────────────────────────────────────────

  /** Sends the reminders that are due now and plans the next one 12 hours later */
  static async sendDue(now: Date = new Date()): Promise<number> {
    const claimed = await db
      .update(dueReminders)
      .set({ lastNotifiedAt: now, notifyCount: sql`${dueReminders.notifyCount} + 1`, nextNotifyAt: nextRepeatAt(now), updatedAt: now })
      .where(and(eq(dueReminders.status, 'active'), lte(dueReminders.nextNotifyAt, now)))
      .returning();
    const today = localParts(now).day;
    for (const r of claimed) {
      try {
        if (!(await this.tenantLive(r.tenantId))) continue;
        const members = await membersOf(r.tenantId);
        const owner = members.find((m) => m.id === r.ownerId);
        // Nobody responsible any more (e.g. removed): tell the Admins instead
        const recipients = owner ? [owner] : members.filter((m) => m.admin);
        for (const to of recipients) {
          await this.notify(r, to, owner ? r.title : `${r.title} (nobody responsible)`, today);
        }
      } catch (err) {
        logger.error({ err, reminderId: r.id }, '[DueReminders] Sending failed');
      }
    }
    return claimed.length;
  }

  /** Tells the Admins once about each reminder still not done after its due date */
  static async escalateOverdue(now: Date = new Date()): Promise<number> {
    const { day: today, hhmm } = localParts(now);
    if (hhmm < QUIET_UNTIL || hhmm >= QUIET_FROM) return 0;
    const claimed = await db
      .update(dueReminders)
      .set({ escalatedAt: now, updatedAt: now })
      .where(and(eq(dueReminders.status, 'active'), isNull(dueReminders.escalatedAt), lt(dueReminders.dueDate, today)))
      .returning();
    for (const r of claimed) {
      try {
        if (!(await this.tenantLive(r.tenantId))) continue;
        const members = await membersOf(r.tenantId);
        const owner = members.find((m) => m.id === r.ownerId);
        const who = owner ? fullName(owner) : 'nobody';
        for (const admin of members.filter((m) => m.admin && m.id !== r.ownerId)) {
          await this.notify(r, admin, `${r.title} (responsible: ${who})`, today, who);
        }
        logger.info({ tenantId: r.tenantId, reminderId: r.id }, '[DueReminders] Overdue: Admins told');
      } catch (err) {
        logger.error({ err, reminderId: r.id }, '[DueReminders] Escalation failed');
      }
    }
    return claimed.length;
  }

  private static async tenantLive(tenantId: string) {
    const [t] = await db.select({ isActive: tenants.isActive, deletedAt: tenants.deletedAt }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return !!t?.isActive && !t.deletedAt && (await SectionsService.isEnabled(tenantId, 'reminders'));
  }

  /** escalatedFor = name of the person who has not done it (for the Admins) */
  private static async notify(r: Row, to: Member, what: string, today: string, escalatedFor?: string) {
    const escalation = escalatedFor !== undefined;
    const due = dueLabel(r.dueDate, today);
    await withTenant(r.tenantId, (tx) => NotificationsService.notify({
      tenantId: r.tenantId, recipientUserId: to.id, type: escalation ? 'due_reminder_overdue' : 'due_reminder',
      entityType: 'reminder', entityId: r.id, priority: r.dueDate <= today ? 'warning' : 'info',
      title: escalation ? `Overdue: ${r.title}` : `Reminder: ${r.title}`,
      message: `Due ${due} · ${amountLabel(r.amount)}${escalation ? ` · ${escalatedFor} has not marked it done` : ''}`,
    }, tx));
    if (!to.phone) return;
    const wa = await WhatsAppBotsService.forTenant(r.tenantId);
    const sent = await WhatsAppService.sendBodyAndLinkTemplate(
      to.phone, env.WHATSAPP_DUE_REMINDER_TEMPLATE, wa.templates.lang, [to.firstName, what, due, amountLabel(r.amount)], r.id, wa.sender,
    );
    if (!sent.success) logger.warn({ to: maskPhone(to.phone), reminderId: r.id, error: sent.error }, '[DueReminders] WhatsApp failed');
  }
}

/** Every minute in the API process (off with TASK_REMINDERS_ENABLED=false, like the other reminders) */
export function startDueReminders() {
  if (env.TASK_REMINDERS_ENABLED === 'false') return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await DueRemindersService.sendDue();
      await DueRemindersService.escalateOverdue();
    } catch (err) {
      logger.error({ err }, '[DueReminders] Check failed');
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, 60_000);
  logger.info('[DueReminders] Checking bill/renewal reminders every minute');
}
