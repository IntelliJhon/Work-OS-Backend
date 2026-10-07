import { and, between, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { taskTimeLogs, timeLogReminders } from '../../db/schema/time_logs';
import { workReports } from '../../db/schema/work_reports';
import { tasks } from '../../db/schema/tasks';
import { projects } from '../../db/schema/projects';
import { users } from '../../db/schema/users';
import { tenants } from '../../db/schema/tenants';
import { attendanceRecords } from '../../db/schema/attendance';
import { withTenant } from '../../middleware/tenant.middleware';
import { AttendanceService, localParts } from '../attendance/attendance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SectionsService } from '../sections/sections.service';
import { formatWorkId } from '../tasks/tasks.service';
import { canSeeTask, taskScope } from '../tasks/task-visibility';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Time worked on project tasks. The person a project task is assigned to logs, for each day, how long they worked
 * on it and what they did, until the task is done. Every entry is also a work report of that person in the
 * Employees section (kept in step: changing or deleting the entry changes or deletes the report).
 * Hours are seen by the person themselves, and by Admins and Project Managers.
 */

export class TimeLogError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** A full working day */
export const DAY_MINUTES = 8 * 60;
/** How far back a day can still be logged or changed */
export const BACK_DAYS = 7;
/** The "log your time" reminder goes out from this local time */
export const REMINDER_AT = '18:00';

type Log = typeof taskTimeLogs.$inferSelect;
interface Me { id: string; firstName: string; lastName: string; email: string }

const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const today = () => localParts(new Date()).day;
const fullName = (u: { firstName: string | null; lastName: string | null }) => `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();

/** 150 → "2h 30m" */
export function formatMinutes(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

async function person(tenantId: string, userId: string): Promise<Me> {
  const [u] = await withTenant<Me[]>(tenantId, (tx) =>
    tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users)
      .where(and(eq(users.id, userId), eq(users.tenantId, tenantId))).limit(1),
  );
  if (!u) throw new TimeLogError(404, 'not_found', 'User not found');
  return u;
}

async function taskRow(tenantId: string, taskId: string) {
  const [t] = await withTenant<(typeof tasks.$inferSelect)[]>(tenantId, (tx) =>
    tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt))).limit(1),
  );
  if (!t) throw new TimeLogError(404, 'not_found', 'Work item not found');
  return t;
}

async function projectName(tenantId: string, projectId: string | null) {
  if (!projectId) return null;
  const [p] = await withTenant<{ name: string }[]>(tenantId, (tx) => tx.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1));
  return p?.name ?? null;
}

function checkDay(workDate: string) {
  const now = today();
  if (workDate > now) throw new TimeLogError(400, 'future', "You can't log time for a day that hasn't come yet");
  if (workDate < addDays(now, -BACK_DAYS)) throw new TimeLogError(400, 'too_old', `Time can only be logged for the last ${BACK_DAYS} days`);
}

async function dayTotal(tenantId: string, userId: string, workDate: string, exceptId?: string) {
  const [row] = await db.select({ total: sql<number>`coalesce(sum(${taskTimeLogs.minutes}), 0)::int` }).from(taskTimeLogs).where(and(
    eq(taskTimeLogs.tenantId, tenantId), eq(taskTimeLogs.userId, userId), eq(taskTimeLogs.workDate, workDate),
    exceptId ? ne(taskTimeLogs.id, exceptId) : undefined,
  ));
  return row?.total ?? 0;
}

function reportFields(task: typeof tasks.$inferSelect, project: string | null, log: { minutes: number; note: string; workDate: string }) {
  const workId = formatWorkId(task.taskNumber);
  const head = [workId, task.name].filter(Boolean).join(' ');
  return {
    title: `${head}${project ? ` · ${project}` : ''} — ${formatMinutes(log.minutes)}`.slice(0, 255),
    reportText: log.note,
    workDate: log.workDate,
    minutes: log.minutes,
    taskId: task.id,
    projectId: task.projectId,
    updatedAt: new Date(),
  };
}

export class TimeLogsService {
  /** Whether this person sees everyone's hours (Admins and Project Managers) */
  static async seesEveryone(tenantId: string, userId: string) {
    return (await withTenant(tenantId, (tx) => taskScope(tx, tenantId, userId))).all;
  }

  private static async view(tenantId: string, rows: Log[], viewerId: string) {
    const ids = [...new Set(rows.map((r) => r.userId))];
    const people = ids.length
      ? await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
        tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, ids))))
      : [];
    const names = new Map(people.map((p) => [p.id, fullName(p)]));
    const now = today();
    return rows.map((r) => ({
      ...r,
      userName: names.get(r.userId) ?? null,
      canEdit: r.userId === viewerId && r.workDate >= addDays(now, -BACK_DAYS),
    }));
  }

  /** Entries on one work item, with the totals (anyone who can see the work item) */
  static async forTask(tenantId: string, viewerId: string, taskId: string) {
    const task = await taskRow(tenantId, taskId);
    const scope = await withTenant(tenantId, (tx) => taskScope(tx, tenantId, viewerId));
    if (!canSeeTask(scope, task)) throw new TimeLogError(404, 'not_found', 'Work item not found');
    const rows = await db.select().from(taskTimeLogs)
      .where(and(eq(taskTimeLogs.tenantId, tenantId), eq(taskTimeLogs.taskId, taskId)))
      .orderBy(desc(taskTimeLogs.workDate), desc(taskTimeLogs.createdAt));
    const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
    return {
      entries: await this.view(tenantId, rows, viewerId),
      totalMinutes,
      estimateMinutes: task.timeEstimate ? task.timeEstimate * 60 : null,
      canLog: task.assigneeId === viewerId && !!task.projectId && task.status !== 'done',
      reason: task.assigneeId !== viewerId ? 'not_assignee' : !task.projectId ? 'not_project' : task.status === 'done' ? 'done' : null,
    };
  }

  static async create(tenantId: string, userId: string, input: { taskId: string; workDate: string; minutes: number; note: string }) {
    const task = await taskRow(tenantId, input.taskId);
    if (task.assigneeId !== userId) throw new TimeLogError(403, 'not_assignee', 'Only the person this work is assigned to can log time on it');
    if (!task.projectId) throw new TimeLogError(400, 'not_project', 'Time is logged on work items that belong to a project');
    if (task.status === 'done') throw new TimeLogError(400, 'done', 'This work is done, so no more time can be logged on it');
    checkDay(input.workDate);
    const note = input.note.trim();
    if (!note) throw new TimeLogError(400, 'note', 'Write what you did');
    if ((await dayTotal(tenantId, userId, input.workDate)) + input.minutes > 24 * 60) {
      throw new TimeLogError(400, 'day_full', 'That would be more than 24 hours on one day');
    }
    const me = await person(tenantId, userId);
    const project = await projectName(tenantId, task.projectId);
    return db.transaction(async (tx) => {
      const [report] = await tx.insert(workReports).values({
        tenantId,
        employeeId: userId,
        authorId: userId,
        authorName: fullName(me),
        authorEmail: me.email,
        ...reportFields(task, project, { minutes: input.minutes, note, workDate: input.workDate }),
      }).returning();
      const [log] = await tx.insert(taskTimeLogs).values({
        tenantId, taskId: task.id, projectId: task.projectId, userId, workDate: input.workDate, minutes: input.minutes, note, workReportId: report.id,
      }).returning();
      return log;
    });
  }

  private static async own(tenantId: string, userId: string, logId: string) {
    const [log] = await db.select().from(taskTimeLogs).where(and(eq(taskTimeLogs.id, logId), eq(taskTimeLogs.tenantId, tenantId))).limit(1);
    if (!log) throw new TimeLogError(404, 'not_found', 'Time entry not found');
    if (log.userId !== userId) throw new TimeLogError(403, 'forbidden', 'You can only change your own time entries');
    if (log.workDate < addDays(today(), -BACK_DAYS)) throw new TimeLogError(400, 'too_old', `Entries older than ${BACK_DAYS} days can't be changed`);
    return log;
  }

  static async update(tenantId: string, userId: string, logId: string, input: { workDate?: string; minutes?: number; note?: string }) {
    const log = await this.own(tenantId, userId, logId);
    const task = await taskRow(tenantId, log.taskId);
    if (task.status === 'done') throw new TimeLogError(400, 'done', 'This work is done, so its time entries are final');
    const next = {
      workDate: input.workDate ?? log.workDate,
      minutes: input.minutes ?? log.minutes,
      note: input.note !== undefined ? input.note.trim() : log.note,
    };
    if (!next.note) throw new TimeLogError(400, 'note', 'Write what you did');
    checkDay(next.workDate);
    if ((await dayTotal(tenantId, userId, next.workDate, log.id)) + next.minutes > 24 * 60) {
      throw new TimeLogError(400, 'day_full', 'That would be more than 24 hours on one day');
    }
    const project = await projectName(tenantId, task.projectId);
    return db.transaction(async (tx) => {
      const [updated] = await tx.update(taskTimeLogs).set({ ...next, updatedAt: new Date() }).where(eq(taskTimeLogs.id, log.id)).returning();
      if (log.workReportId) {
        await tx.update(workReports).set(reportFields(task, project, next)).where(eq(workReports.id, log.workReportId));
      }
      return updated;
    });
  }

  static async remove(tenantId: string, userId: string, logId: string) {
    const log = await this.own(tenantId, userId, logId);
    const task = await taskRow(tenantId, log.taskId);
    if (task.status === 'done') throw new TimeLogError(400, 'done', 'This work is done, so its time entries are final');
    await db.transaction(async (tx) => {
      await tx.delete(taskTimeLogs).where(eq(taskTimeLogs.id, log.id));
      if (log.workReportId) await tx.delete(workReports).where(eq(workReports.id, log.workReportId));
    });
    return { deleted: true };
  }

  /**
   * Hours per day for people, with what a full day is: 8 h on working days, 4 h on a half day of leave, nothing on
   * leave days, days off and holidays. The person themselves, or Admins and Project Managers.
   */
  static async daily(tenantId: string, viewerId: string, opts: { userId?: string; from: string; to: string }) {
    if (opts.to < opts.from) throw new TimeLogError(400, 'range', 'The end date is before the start date');
    if (addDays(opts.from, 62) < opts.to) throw new TimeLogError(400, 'range', 'Choose at most two months');
    const everyone = await this.seesEveryone(tenantId, viewerId);
    const who = opts.userId ?? (everyone ? undefined : viewerId);
    if (who && who !== viewerId && !everyone) throw new TimeLogError(403, 'forbidden', "Only Admins and Project Managers can see other people's hours");

    const people = await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
      tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt), who ? eq(users.id, who) : undefined)),
    );
    const ids = people.map((p) => p.id);
    if (!ids.length) return { from: opts.from, to: opts.to, dayMinutes: DAY_MINUTES, people: [] };

    const [workdays, sums, leaves] = await Promise.all([
      AttendanceService.workingDays(tenantId, opts.from, opts.to),
      db.select({ userId: taskTimeLogs.userId, workDate: taskTimeLogs.workDate, minutes: sql<number>`sum(${taskTimeLogs.minutes})::int` })
        .from(taskTimeLogs)
        .where(and(eq(taskTimeLogs.tenantId, tenantId), inArray(taskTimeLogs.userId, ids), between(taskTimeLogs.workDate, opts.from, opts.to)))
        .groupBy(taskTimeLogs.userId, taskTimeLogs.workDate),
      db.select({ userId: attendanceRecords.userId, day: attendanceRecords.day, leaveHalf: attendanceRecords.leaveHalf }).from(attendanceRecords)
        .where(and(eq(attendanceRecords.tenantId, tenantId), inArray(attendanceRecords.userId, ids), between(attendanceRecords.day, opts.from, opts.to), eq(attendanceRecords.status, 'leave'))),
    ]);
    const working = new Set(workdays);
    const logged = new Map(sums.map((s) => [`${s.userId}|${s.workDate}`, s.minutes]));
    const leave = new Map(leaves.map((l) => [`${l.userId}|${l.day}`, l.leaveHalf ? 'half' : 'full']));
    const now = today();
    const days: string[] = [];
    for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) days.push(d);

    return {
      from: opts.from,
      to: opts.to,
      dayMinutes: DAY_MINUTES,
      people: people.map((p) => {
        const rows = days.map((d) => {
          const l = leave.get(`${p.id}|${d}`) ?? null;
          const expected = !working.has(d) || l === 'full' ? 0 : l === 'half' ? DAY_MINUTES / 2 : DAY_MINUTES;
          const minutes = logged.get(`${p.id}|${d}`) ?? 0;
          return {
            date: d,
            minutes,
            expectedMinutes: expected,
            workingDay: working.has(d),
            leave: l,
            future: d > now,
            // Highlighted: a past or current working day with less than a full day logged
            short: d <= now && expected > 0 && minutes < expected,
          };
        });
        return {
          userId: p.id,
          name: fullName(p),
          totalMinutes: rows.reduce((s, r) => s + r.minutes, 0),
          shortDays: rows.filter((r) => r.short && r.date < now).length,
          days: rows,
        };
      }).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // ─── 6 pm reminder ──────────────────────────────────────────────────────────

  /**
   * From 6 pm on a working day: people with open project work who have logged nothing today get one in-app
   * reminder (not on leave). Sent once per person per day.
   */
  static async remindToday(now: Date = new Date(), onlyTenantIds?: string[]) {
    const { day, hhmm } = localParts(now);
    if (hhmm < REMINDER_AT) return 0;
    const live = onlyTenantIds ? onlyTenantIds.map((id) => ({ id })) : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.isActive, true));
    let sent = 0;
    for (const t of live) {
      try {
        if (!(await SectionsService.isEnabled(t.id, 'tasks')) || !(await SectionsService.isEnabled(t.id, 'projects'))) continue;
        if (!(await AttendanceService.workingDays(t.id, day, day)).length) continue;
        const open = await withTenant<{ userId: string | null }[]>(t.id, (tx) =>
          tx.selectDistinct({ userId: tasks.assigneeId }).from(tasks).where(and(
            eq(tasks.tenantId, t.id), isNotNull(tasks.projectId), isNotNull(tasks.assigneeId), isNull(tasks.deletedAt), ne(tasks.status, 'done'),
          )),
        );
        const candidates = open.map((o) => o.userId).filter((v): v is string => !!v);
        if (!candidates.length) continue;
        const [loggedToday, remindedToday, onLeave, active] = await Promise.all([
          db.selectDistinct({ userId: taskTimeLogs.userId }).from(taskTimeLogs).where(and(eq(taskTimeLogs.tenantId, t.id), eq(taskTimeLogs.workDate, day), inArray(taskTimeLogs.userId, candidates))),
          db.select({ userId: timeLogReminders.userId }).from(timeLogReminders).where(and(eq(timeLogReminders.tenantId, t.id), eq(timeLogReminders.workDate, day))),
          db.select({ userId: attendanceRecords.userId }).from(attendanceRecords).where(and(
            eq(attendanceRecords.tenantId, t.id), eq(attendanceRecords.day, day), eq(attendanceRecords.status, 'leave'), isNull(attendanceRecords.leaveHalf),
          )),
          withTenant<{ id: string }[]>(t.id, (tx) => tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, t.id), isNull(users.deletedAt), inArray(users.id, candidates)))),
        ]);
        const skip = new Set([...loggedToday, ...remindedToday, ...onLeave].map((r) => r.userId));
        for (const { id: userId } of active) {
          if (skip.has(userId)) continue;
          const [claimed] = await db.insert(timeLogReminders).values({ tenantId: t.id, userId, workDate: day }).onConflictDoNothing().returning();
          if (!claimed) continue;
          await withTenant(t.id, (tx) => NotificationsService.notify({
            tenantId: t.id, recipientUserId: userId, type: 'time_log_reminder', entityType: 'time_log', entityId: userId,
            title: 'Log your time for today',
            message: 'You have open project work but no hours logged today. Open the project\'s Task Planner and use "Log time".',
            priority: 'info',
          }, tx));
          sent++;
        }
      } catch (err) {
        logger.error({ err, tenantId: t.id }, '[TimeLogs] Reminder check failed');
      }
    }
    if (sent) logger.info({ sent, day }, '[TimeLogs] Sent "log your time" reminders');
    return sent;
  }
}

export function startTimeLogReminders() {
  if (env.TASK_REMINDERS_ENABLED === 'false') return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await TimeLogsService.remindToday();
    } catch (err) {
      logger.error({ err }, '[TimeLogs] Reminder check failed');
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 20_000);
  setInterval(tick, 5 * 60_000);
  logger.info('[TimeLogs] "Log your time" reminders from 6 pm on working days');
}

// Used by the work reports list: newest work day first
export const reportOrder = [desc(sql`coalesce(${workReports.workDate}, ${workReports.createdAt}::date)`), desc(workReports.createdAt)];
