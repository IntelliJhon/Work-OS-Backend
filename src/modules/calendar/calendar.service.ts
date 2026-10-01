import crypto from 'crypto';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { db } from '../../db';
import { calendarFeeds } from '../../db/schema/calendar_feeds';
import { tasks } from '../../db/schema/tasks';
import { tenants } from '../../db/schema/tenants';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { env } from '../../config/env';
import { formatWorkId } from '../tasks/tasks.service';
import { formatDueLabel } from './task-schedule';
import { SectionsService } from '../sections/sections.service';

/**
 * Personal calendar feeds (iCalendar). Each user gets a private link to their assigned work, which they add
 * once to Google Calendar, Outlook or Apple Calendar. The token in the link is the only credential.
 */

export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const FINISHED_STATUSES = ['done', 'completed', 'cancelled'];
// Work due before this is left out of the feed
const PAST_DAYS = 30;

async function createFeed(tenantId: string, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.insert(calendarFeeds).values({ userId, tenantId, tokenHash: hashToken(token), tokenEncrypted: encryptSecret(token) });
  return token;
}

export class CalendarService {
  /** The user's calendar link token, created on first use. */
  static async getFeedToken(tenantId: string, userId: string): Promise<string> {
    const [feed] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.userId, userId)).limit(1);
    if (feed && feed.tenantId === tenantId) return decryptSecret(feed.tokenEncrypted);
    if (feed) await db.delete(calendarFeeds).where(eq(calendarFeeds.userId, userId));
    return createFeed(tenantId, userId);
  }

  /** A new link; the old one stops working (e.g. after it was shared by mistake). */
  static async resetFeedToken(tenantId: string, userId: string): Promise<string> {
    await db.delete(calendarFeeds).where(eq(calendarFeeds.userId, userId));
    return createFeed(tenantId, userId);
  }

  /** The iCalendar file for a link token, or null if the link isn't valid (any more). */
  static async buildFeed(token: string): Promise<string | null> {
    const [feed] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.tokenHash, hashToken(token))).limit(1);
    if (!feed) return null;
    const [tenant] = await db
      .select({ name: tenants.name })
      .from(tenants)
      .where(and(eq(tenants.id, feed.tenantId), eq(tenants.isActive, true), isNull(tenants.deletedAt)))
      .limit(1);
    if (!tenant) return null;
    if (!(await SectionsService.isEnabled(feed.tenantId, 'calendar'))) return null;

    const work = await withTenant(feed.tenantId, async (tx) => {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, feed.userId), isNull(users.deletedAt)))
        .limit(1);
      if (!user) return null;
      return tx
        .select()
        .from(tasks)
        .where(and(
          eq(tasks.tenantId, feed.tenantId),
          eq(tasks.assigneeId, feed.userId),
          isNull(tasks.deletedAt),
          notInArray(tasks.status, FINISHED_STATUSES),
        ));
    });
    if (!work) return null;

    const earliest = new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString().slice(0, 10);
    const dated = (work as (typeof tasks.$inferSelect)[]).filter((t) => {
      const dueDate = (t.customFields as Record<string, unknown> | null)?.dueDate;
      return typeof dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && dueDate >= earliest;
    });
    return renderCalendar(tenant.name, dated);
  }
}

// ─── iCalendar ─────────────────────────────────────────────────────────────────

/** The iCalendar file for a workspace's work (tasks with a valid due date). */
export function renderCalendar(workspaceName: string, work: (typeof tasks.$inferSelect)[]): string {
  return toIcs([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Work OS//Work calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`Work OS – ${workspaceName}`)}`,
    `X-WR-TIMEZONE:${env.WORK_TIMEZONE}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...work.map(taskEvent).flat(),
    'END:VCALENDAR',
  ]);
}

const escapeText = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** 20260929T113000Z */
const utcStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateValue = (isoDate: string) => isoDate.replace(/-/g, '');
const nextDay = (isoDate: string) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

function taskEvent(task: typeof tasks.$inferSelect): string[] {
  const cf = (task.customFields ?? {}) as Record<string, unknown>;
  const workId = formatWorkId(task.taskNumber);
  const due = formatDueLabel(cf);
  const description = [
    task.description?.slice(0, 1500),
    due ? `Due: ${due}` : null,
    env.APP_URL && !env.APP_URL.includes('localhost') ? `${env.APP_URL.replace(/\/+$/, '')}/dashboard/tasks` : null,
  ].filter(Boolean).join('\n\n');

  const lines = [
    'BEGIN:VEVENT',
    `UID:${task.id}@work-os`,
    `DTSTAMP:${utcStamp(new Date(task.updatedAt ?? Date.now()))}`,
    `SUMMARY:${escapeText(workId ? `${workId} · ${task.name}` : task.name)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);

  if (task.dueAt) {
    // A timed due: a 30-minute slot starting at the due time
    const start = new Date(task.dueAt);
    lines.push(`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(new Date(start.getTime() + 30 * 60_000))}`);
    // The same moment as the WhatsApp reminder (which may be the 30-minute fallback)
    const minutes = task.remindAt ? Math.round((start.getTime() - new Date(task.remindAt).getTime()) / 60_000) : 0;
    if (minutes > 0) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(`Due: ${task.name}`)}`, `TRIGGER:-PT${minutes}M`, 'END:VALARM');
    }
  } else {
    const dueDate = String(cf.dueDate);
    lines.push(`DTSTART;VALUE=DATE:${dateValue(dueDate)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(dueDate))}`);
  }
  lines.push('END:VEVENT');
  return lines;
}

/** Lines joined with CRLF and folded at 75 octets, as iCalendar requires. */
function toIcs(lines: string[]): string {
  const folded = lines.map((line) => {
    if (Buffer.byteLength(line) <= 75) return line;
    const parts: string[] = [];
    let current = '';
    for (const ch of line) {
      const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
      if (Buffer.byteLength(current + ch) > limit) {
        parts.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    parts.push(current);
    return parts.join('\r\n ');
  });
  return `${folded.join('\r\n')}\r\n`;
}
