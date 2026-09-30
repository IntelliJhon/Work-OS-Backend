import { and, asc, between, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { attendanceHolidays, attendanceRecords, attendanceSettings } from '../../db/schema/attendance';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Daily attendance. The first check-in of the day (the first time the person uses Work OS from checkInFrom on,
 * recorded with the server's clock) decides the day:
 *   before earlyBefore (09:30)  → Present · Early
 *   up to lateAfter (09:35)     → Present
 *   after lateAfter             → Late
 *   from absentAfter (12:00)    → Absent (and a working day with no check-in by then is Absent)
 * Later logins that day change nothing. Non-working days and holidays are not counted; leave overrides absent.
 * All days and times are local to WORK_TIMEZONE.
 */

export type AttendanceStatus = 'present' | 'late' | 'absent' | 'leave';
/** A person's day as shown: a stored status, or one implied by the calendar */
export type DayState = AttendanceStatus | 'holiday' | 'day_off' | 'not_checked_in' | 'not_counted';

export class AttendanceError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface LocationInput {
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  /** ok | denied | unavailable */
  status?: string | null;
}

type Settings = typeof attendanceSettings.$inferSelect;
type RecordRow = typeof attendanceRecords.$inferSelect;

const DEFAULTS = {
  enabled: true,
  earlyBefore: '09:30',
  lateAfter: '09:35',
  checkInFrom: '07:00',
  absentAfter: '12:00',
  workingDays: [1, 2, 3, 4, 5, 6],
};

// ─── Local time ────────────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The local day ('YYYY-MM-DD'), time ('HH:mm') and ISO weekday of a moment */
export function localParts(at: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: env.WORK_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}:${get('minute')}`, weekday: WEEKDAYS[get('weekday')] };
}

const weekdayOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
};
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
export const isRealDay = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
/** Every day of a 'YYYY-MM' month */
const daysOfMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};

/** Status for a first check-in at a local time */
export function statusAt(hhmm: string, s: Pick<Settings, 'earlyBefore' | 'lateAfter' | 'absentAfter'>): { status: AttendanceStatus; early: boolean } {
  if (hhmm >= s.absentAfter) return { status: 'absent', early: false };
  if (hhmm > s.lateAfter) return { status: 'late', early: false };
  return { status: 'present', early: hhmm < s.earlyBefore };
}

// ─── Service ───────────────────────────────────────────────────────────────────

export class AttendanceService {
  /** The workspace's rules (created with defaults on first use; counting starts that day). */
  static async getSettings(tenantId: string): Promise<Settings> {
    const [row] = await db.select().from(attendanceSettings).where(eq(attendanceSettings.tenantId, tenantId)).limit(1);
    if (row) return row;
    const [created] = await db
      .insert(attendanceSettings)
      .values({ tenantId, startedOn: localParts(new Date()).day })
      .onConflictDoNothing()
      .returning();
    return created ?? (await db.select().from(attendanceSettings).where(eq(attendanceSettings.tenantId, tenantId)).limit(1))[0];
  }

  static async updateSettings(tenantId: string, actorId: string, input: Partial<typeof DEFAULTS>) {
    const current = await this.getSettings(tenantId);
    const next = { ...current, ...input };
    if (!(next.checkInFrom <= next.earlyBefore && next.earlyBefore <= next.lateAfter && next.lateAfter < next.absentAfter)) {
      throw new AttendanceError(400, 'invalid_times', 'Times must be in order: check-in opens ≤ early before ≤ late after < absent after');
    }
    const workingDays = [...new Set(next.workingDays)].filter((d) => d >= 1 && d <= 7).sort();
    const [row] = await db
      .update(attendanceSettings)
      .set({
        enabled: next.enabled,
        earlyBefore: next.earlyBefore,
        lateAfter: next.lateAfter,
        checkInFrom: next.checkInFrom,
        absentAfter: next.absentAfter,
        workingDays,
        updatedBy: actorId,
        updatedAt: new Date(),
      })
      .where(eq(attendanceSettings.tenantId, tenantId))
      .returning();
    return row;
  }

  static async holidaysBetween(tenantId: string, from: string, to: string) {
    return db
      .select()
      .from(attendanceHolidays)
      .where(and(eq(attendanceHolidays.tenantId, tenantId), between(attendanceHolidays.day, from, to)))
      .orderBy(asc(attendanceHolidays.day));
  }

  /**
   * Records the day's first check-in, if there is none yet. Idempotent: the app calls it on every visit.
   * created=false with the existing record when the day was already decided.
   */
  static async checkIn(tenantId: string, userId: string, location: LocationInput, now: Date = new Date()) {
    const settings = await this.getSettings(tenantId);
    const { day, hhmm, weekday } = localParts(now);
    if (!settings.enabled) return { code: 'disabled' as const, created: false, day };

    const [existing] = await db
      .select()
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.tenantId, tenantId), eq(attendanceRecords.userId, userId), eq(attendanceRecords.day, day)))
      .limit(1);
    if (existing) return { code: 'recorded' as const, created: false, day, record: existing };

    if (!settings.workingDays.includes(weekday)) return { code: 'day_off' as const, created: false, day };
    const [holiday] = await this.holidaysBetween(tenantId, day, day);
    if (holiday) return { code: 'holiday' as const, created: false, day, holiday: holiday.name };
    if (hhmm < settings.checkInFrom) return { code: 'too_early' as const, created: false, day, opensAt: settings.checkInFrom };

    const { status, early } = statusAt(hhmm, settings);
    const hasCoords = Number.isFinite(location.latitude) && Number.isFinite(location.longitude)
      && Math.abs(location.latitude!) <= 90 && Math.abs(location.longitude!) <= 180;
    const locationStatus = hasCoords ? 'ok' : location.status === 'denied' ? 'denied' : 'unavailable';

    const [created] = await db
      .insert(attendanceRecords)
      .values({
        tenantId,
        userId,
        day,
        status,
        early,
        checkInAt: now,
        latitude: hasCoords ? location.latitude! : null,
        longitude: hasCoords ? location.longitude! : null,
        accuracyM: hasCoords && Number.isFinite(location.accuracy) ? location.accuracy! : null,
        locationStatus,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      // Another tab checked in at the same moment
      const [row] = await db
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.tenantId, tenantId), eq(attendanceRecords.userId, userId), eq(attendanceRecords.day, day)))
        .limit(1);
      return { code: 'recorded' as const, created: false, day, record: row };
    }
    logger.info({ tenantId, userId, day, status, early, locationStatus }, '[Attendance] Checked in');
    return { code: 'recorded' as const, created: true, day, record: created };
  }

  /** Members counted on a day (not deleted, joined on or before it) */
  private static async members(tenantId: string) {
    return withTenant<{ id: string; firstName: string; lastName: string; email: string; createdAt: Date }[]>(tenantId, (tx) =>
      tx
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, createdAt: users.createdAt })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)))
        .orderBy(asc(users.firstName), asc(users.lastName)),
    );
  }

  /** What a person's day is: their record, or what the calendar implies */
  private static stateOf(
    day: string,
    record: RecordRow | undefined,
    ctx: { settings: Settings; holidays: Set<string>; now: ReturnType<typeof localParts>; joinedOn: string },
  ): DayState {
    if (record) return record.status as AttendanceStatus;
    if (day < ctx.settings.startedOn || day < ctx.joinedOn || day > ctx.now.day) return 'not_counted';
    if (!ctx.settings.workingDays.includes(weekdayOf(day))) return 'day_off';
    if (ctx.holidays.has(day)) return 'holiday';
    if (day === ctx.now.day && ctx.now.hhmm < ctx.settings.absentAfter) return 'not_checked_in';
    return 'absent';
  }

  /** Everyone's attendance on one day */
  static async day(tenantId: string, day: string, now: Date = new Date()) {
    const [settings, members, records, holidays] = await Promise.all([
      this.getSettings(tenantId),
      this.members(tenantId),
      db.select().from(attendanceRecords).where(and(eq(attendanceRecords.tenantId, tenantId), eq(attendanceRecords.day, day))),
      this.holidaysBetween(tenantId, day, day),
    ]);
    const byUser = new Map(records.map((r) => [r.userId, r]));
    const ctxBase = { settings, holidays: new Set(holidays.map((h) => h.day)), now: localParts(now) };
    return {
      day,
      holiday: holidays[0]?.name ?? null,
      settings,
      people: members.map((m) => {
        const record = byUser.get(m.id);
        return {
          userId: m.id,
          name: `${m.firstName} ${m.lastName}`.trim(),
          email: m.email,
          state: this.stateOf(day, record, { ...ctxBase, joinedOn: localParts(new Date(m.createdAt)).day }),
          record: record ?? null,
        };
      }),
    };
  }

  /** A month for everyone (or one person): each person's day states and totals */
  static async month(tenantId: string, month: string, onlyUserId?: string, now: Date = new Date()) {
    const days = daysOfMonth(month);
    const from = days[0];
    const to = days[days.length - 1];
    const [settings, allMembers, records, holidays] = await Promise.all([
      this.getSettings(tenantId),
      this.members(tenantId),
      db
        .select()
        .from(attendanceRecords)
        .where(and(
          eq(attendanceRecords.tenantId, tenantId),
          between(attendanceRecords.day, from, to),
          onlyUserId ? eq(attendanceRecords.userId, onlyUserId) : sql`true`,
        )),
      this.holidaysBetween(tenantId, from, to),
    ]);
    const members = onlyUserId ? allMembers.filter((m) => m.id === onlyUserId) : allMembers;
    const byKey = new Map(records.map((r) => [`${r.userId}|${r.day}`, r]));
    const ctxBase = { settings, holidays: new Set(holidays.map((h) => h.day)), now: localParts(now) };

    return {
      month,
      days,
      holidays,
      settings,
      people: members.map((m) => {
        const joinedOn = localParts(new Date(m.createdAt)).day;
        const totals = { present: 0, early: 0, late: 0, absent: 0, leave: 0 };
        const perDay = days.map((day) => {
          const record = byKey.get(`${m.id}|${day}`);
          const state = this.stateOf(day, record, { ...ctxBase, joinedOn });
          if (state === 'present') totals.present += 1;
          if (state === 'present' && record?.early) totals.early += 1;
          if (state === 'late') totals.late += 1;
          if (state === 'absent') totals.absent += 1;
          if (state === 'leave') totals.leave += 1;
          return { day, state, early: record?.early ?? false, checkInAt: record?.checkInAt ?? null, locationStatus: record?.locationStatus ?? null };
        });
        return { userId: m.id, name: `${m.firstName} ${m.lastName}`.trim(), totals, days: perDay };
      }),
    };
  }

  /** An admin sets a person's day (e.g. Late → Present, or Absent → Present with a reason). */
  static async correct(
    tenantId: string,
    actorId: string,
    input: { userId: string; day: string; status: AttendanceStatus; early?: boolean; reason: string },
    ipAddress?: string,
  ) {
    await this.assertMember(tenantId, input.userId);
    const early = input.status === 'present' ? !!input.early : false;
    const [before] = await db
      .select()
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.tenantId, tenantId), eq(attendanceRecords.userId, input.userId), eq(attendanceRecords.day, input.day)))
      .limit(1);
    const now = new Date();
    const [row] = await db
      .insert(attendanceRecords)
      .values({ tenantId, userId: input.userId, day: input.day, status: input.status, early, note: input.reason, correctedBy: actorId, correctedAt: now })
      .onConflictDoUpdate({
        target: [attendanceRecords.tenantId, attendanceRecords.userId, attendanceRecords.day],
        set: { status: input.status, early, note: input.reason, correctedBy: actorId, correctedAt: now, updatedAt: now },
      })
      .returning();
    await AuditService.logAction({
      tenantId, userId: actorId, action: before ? 'UPDATE' : 'INSERT', tableName: 'attendance_records',
      recordId: row.id, oldValue: before ?? null, newValue: row, ipAddress,
    });
    return row;
  }

  /** Leave for a person over a range of working days. Days with a check-in are left as they are. */
  static async setLeave(tenantId: string, actorId: string, input: { userId: string; from: string; to: string; reason: string }) {
    await this.assertMember(tenantId, input.userId);
    if (input.to < input.from) throw new AttendanceError(400, 'invalid_range', 'The end date is before the start date');
    const settings = await this.getSettings(tenantId);
    const holidays = new Set((await this.holidaysBetween(tenantId, input.from, input.to)).map((h) => h.day));
    const days: string[] = [];
    for (let d = input.from; d <= input.to && days.length <= 62; d = addDays(d, 1)) {
      if (settings.workingDays.includes(weekdayOf(d)) && !holidays.has(d)) days.push(d);
    }
    if (days.length > 62) throw new AttendanceError(400, 'range_too_long', 'Leave can be set for at most about two months at a time');

    const now = new Date();
    let set = 0;
    for (const day of days) {
      const result = await db
        .insert(attendanceRecords)
        .values({ tenantId, userId: input.userId, day, status: 'leave', note: input.reason, correctedBy: actorId, correctedAt: now })
        .onConflictDoUpdate({
          target: [attendanceRecords.tenantId, attendanceRecords.userId, attendanceRecords.day],
          set: { status: 'leave', early: false, note: input.reason, correctedBy: actorId, correctedAt: now, updatedAt: now },
          // Only replace an admin entry or an absence, never a real check-in
          setWhere: sql`${attendanceRecords.checkInAt} is null or ${attendanceRecords.status} = 'absent'`,
        })
        .returning({ id: attendanceRecords.id });
      set += result.length;
    }
    await AuditService.logAction({
      tenantId, userId: actorId, action: 'UPDATE', tableName: 'attendance_records', recordId: input.userId,
      newValue: { leave: { from: input.from, to: input.to, days: set, reason: input.reason } },
    });
    return { days: set };
  }

  static async addHoliday(tenantId: string, actorId: string, day: string, name: string) {
    const [row] = await db
      .insert(attendanceHolidays)
      .values({ tenantId, day, name, createdBy: actorId })
      .onConflictDoUpdate({ target: [attendanceHolidays.tenantId, attendanceHolidays.day], set: { name } })
      .returning();
    return row;
  }

  static async removeHoliday(tenantId: string, day: string) {
    await db.delete(attendanceHolidays).where(and(eq(attendanceHolidays.tenantId, tenantId), eq(attendanceHolidays.day, day)));
  }

  private static async assertMember(tenantId: string, userId: string) {
    const [member] = await withTenant<{ id: string }[]>(tenantId, (tx) =>
      tx.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId), isNull(users.deletedAt))).limit(1),
    );
    if (!member) throw new AttendanceError(404, 'member_not_found', 'This member is not in your workspace');
  }
}
