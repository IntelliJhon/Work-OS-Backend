import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '../../middleware/tenant.middleware';
import { tasks } from '../../db/schema/tasks';
import { users } from '../../db/schema/users';
import { matchMemberName } from '../../lib/names';
import { formatWorkId } from '../tasks/tasks.service';
import { formatDueLabel, zonedTimeToUtc } from '../calendar/task-schedule';
import { env } from '../../config/env';

/**
 * Answers work-status questions sent to the WhatsApp bot from a workspace's registered numbers.
 * Gemini turns the question into filters (a work ID, or any mix of person, date range and status), e.g.
 *   "status W-96"                          → workNumber 96
 *   "yesterday Shahariyas work status"     → person Shahariyas, 29 Sept–29 Sept, all
 *   "what did Renjith finish this week"    → person Renjith, Mon–today, done
 *   "what's overdue" / "pending work"      → status overdue / open
 * With a date range, "all" means work due in the range plus work finished in it.
 * Read-only; every query is scoped to the sender's workspace.
 */

/** Older n8n versions send a fixed type; 'search' uses the filters */
export type StatusQueryType = 'work_id' | 'person' | 'today' | 'overdue' | 'pending' | 'search';
export type StatusFilter = 'open' | 'done' | 'overdue' | 'all';

export interface StatusQuery {
  queryType?: StatusQueryType;
  workNumber?: number | null;
  personName?: string | null;
  /** 'YYYY-MM-DD', local to WORK_TIMEZONE */
  dateFrom?: string | null;
  dateTo?: string | null;
  status?: StatusFilter | null;
}

type Task = typeof tasks.$inferSelect;
type Member = { id: string; firstName: string; lastName: string };

const FINISHED = ['done', 'completed', 'cancelled'];
const MAX_LINES = 12;
// Without a date, "done" / "all" look back this far for finished work
const RECENT_DONE_DAYS = 7;

const STATUS_LABELS: Record<string, string> = {
  to_do: 'To do',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  completed: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};
const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;
const fullName = (m: { firstName: string; lastName: string }) => `${m.firstName} ${m.lastName}`.trim();
const workId = (t: Task) => formatWorkId(t.taskNumber) ?? t.id.slice(0, 8).toUpperCase();
const cf = (t: Task) => (t.customFields ?? {}) as Record<string, any>;
const isOpen = (t: Task) => !FINISHED.includes(t.status);

// ─── Dates (all as 'YYYY-MM-DD' in the work time zone) ─────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: env.WORK_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const isRealDate = (s: string | null | undefined): s is string => {
  if (!s || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const addDays = (s: string, n: number) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** "Tue, 29 Sept" */
const dayLabel = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
function periodLabel(from: string, to: string, today: string): string {
  if (from === to) {
    if (from === today) return `today (${dayLabel(from)})`;
    if (from === addDays(today, -1)) return `yesterday (${dayLabel(from)})`;
    if (from === addDays(today, 1)) return `tomorrow (${dayLabel(from)})`;
    return dayLabel(from);
  }
  return `${dayLabel(from)} – ${dayLabel(to)}`;
}

const dueDay = (t: Task): string | null => (isRealDate(cf(t).dueDate) ? cf(t).dueDate : null);
const doneDay = (t: Task): string | null => (!isOpen(t) && t.completedAt ? dayOf(new Date(t.completedAt)) : null);

/** The moment work is due: its due time, or the end of its due day when it has only a date */
function dueMoment(t: Task): Date | null {
  if (t.dueAt) return new Date(t.dueAt);
  const day = dueDay(t);
  return day ? zonedTimeToUtc(day, '23:59') : null;
}
const isOverdue = (t: Task, now: Date) => {
  const due = dueMoment(t);
  return isOpen(t) && !!due && due < now;
};

/** "in 2 h", "in 25 min", "3 h ago", "2 days ago" */
function relative(due: Date, now: Date): string {
  const minutes = Math.round((due.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(minutes);
  const span = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  return minutes >= 0 ? `in ${span}` : `${span} ago`;
}

function dueText(t: Task, now: Date): string {
  const label = formatDueLabel(t.customFields);
  if (!label) return 'No due date';
  const due = dueMoment(t);
  if (!due || !isOpen(t)) return label;
  if (due < now) return `${label} (overdue, ${relative(due, now)})`;
  return t.dueAt ? `${label} (${relative(due, now)})` : label;
}

// Open work by due moment (no due date last), then finished work, most recently finished first
function byRelevance(a: Task, b: Task): number {
  if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
  if (!isOpen(a)) return new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime();
  return (dueMoment(a)?.getTime() ?? Infinity) - (dueMoment(b)?.getTime() ?? Infinity);
}

function line(t: Task, now: Date, names: Map<string, string>, withDoer: boolean): string {
  const icon = !isOpen(t) ? '✅' : isOverdue(t, now) ? '⚠️' : '•';
  const doer = withDoer ? ` · ${t.assigneeId ? names.get(t.assigneeId) ?? 'Unknown' : 'Unassigned'}` : '';
  const done = doneDay(t);
  const when = !isOpen(t)
    ? done ? ` · done ${dayLabel(done)}` : ''
    : formatDueLabel(t.customFields) ? ` · due ${formatDueLabel(t.customFields)}` : '';
  return `${icon} ${workId(t)} ${t.name}${doer} · ${statusLabel(t.status)}${when}`;
}

function list(items: Task[], now: Date, names: Map<string, string>, withDoer: boolean): string {
  const shown = items.slice(0, MAX_LINES).map((t) => line(t, now, names, withDoer));
  if (items.length > MAX_LINES) shown.push(`…and ${items.length - MAX_LINES} more. See Work OS for the full list.`);
  return shown.join('\n');
}

/** "1 done, 2 open (1 overdue)" */
function breakdown(items: Task[], now: Date): string {
  const done = items.filter((t) => !isOpen(t)).length;
  const open = items.length - done;
  const overdue = items.filter((t) => isOverdue(t, now)).length;
  return [done ? `${done} done` : null, open ? `${open} open${overdue ? ` (${overdue} overdue)` : ''}` : null]
    .filter(Boolean)
    .join(', ');
}

/** Filters from the older fixed question types */
function normalize(query: StatusQuery, today: string): Required<Pick<StatusQuery, 'status'>> & StatusQuery {
  switch (query.queryType) {
    case 'today':
      return { ...query, dateFrom: today, dateTo: today, status: query.status ?? 'all' };
    case 'overdue':
      return { ...query, status: 'overdue' };
    case 'pending':
    case 'person':
      return { ...query, status: query.status ?? 'open' };
    default: {
      const from = isRealDate(query.dateFrom) ? query.dateFrom : isRealDate(query.dateTo) ? query.dateTo : null;
      const to = isRealDate(query.dateTo) ? query.dateTo : from;
      const [a, b] = from && to && from > to ? [to, from] : [from, to];
      return { ...query, dateFrom: a, dateTo: b, status: query.status ?? (a ? 'all' : 'open') };
    }
  }
}

export class WorkStatusService {
  /** The WhatsApp reply text for a status question. */
  static async answer(tenantId: string, rawQuery: StatusQuery, now: Date = new Date()): Promise<string> {
    const { work, members } = await withTenant(tenantId, async (tx) => ({
      work: (await tx.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt)))) as Task[],
      members: (await tx
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)))) as Member[],
    }));
    const names = new Map(members.map((m) => [m.id, fullName(m)]));
    const today = dayOf(now);

    // One work item
    const n = Number(rawQuery.workNumber);
    if (rawQuery.queryType === 'work_id' || (Number.isInteger(n) && n > 0)) {
      const t = Number.isInteger(n) && n > 0 ? work.find((w) => w.taskNumber === n) : undefined;
      if (!t) return Number.isInteger(n) && n > 0
        ? `I couldn't find W-${n} in your workspace.`
        : 'Which work? Send the work ID, for example "status W-96".';
      const fields = cf(t);
      const done = doneDay(t);
      return [
        `📋 ${workId(t)} · ${t.name}`,
        `👤 Doer: ${t.assigneeId ? names.get(t.assigneeId) ?? 'Unknown' : 'Unassigned'}`,
        `📌 Status: ${statusLabel(t.status)}${done ? ` (done ${dayLabel(done)})` : ''}`,
        `📅 Due: ${dueText(t, now)}`,
        fields.reviewerName ? `✅ Checks it: ${fields.reviewerName}` : null,
      ].filter(Boolean).join('\n');
    }

    const query = normalize(rawQuery, today);
    const status: StatusFilter = query.status ?? 'open';

    // Whose work (optional)
    let person: Member | null = null;
    const heard = (query.personName || '').trim();
    if (heard) {
      const match = matchMemberName(heard, members);
      if (match.kind === 'ambiguous') {
        return `Which ${heard}?\n${match.candidates.map((m) => `• ${fullName(m)}`).join('\n')}\n\nSend the full name.`;
      }
      if (match.kind === 'none') {
        const hint = match.suggestions.length ? ` Did you mean ${match.suggestions.map(fullName).join(' or ')}?` : '';
        return `I couldn't find "${heard}" in your workspace.${hint}`;
      }
      person = match.member;
    }
    const pool = person ? work.filter((t) => t.assigneeId === person!.id) : work;

    // Which work: by status, within the date range (due in it, or finished in it)
    const from = query.dateFrom ?? null;
    const to = query.dateTo ?? null;
    const inRange = (day: string | null) => !!day && !!from && !!to && day >= from && day <= to;
    const recentDone = (t: Task) => !isOpen(t) && !!doneDay(t) && doneDay(t)! >= addDays(today, -RECENT_DONE_DAYS);

    let items: Task[];
    if (from && to) {
      const dueIn = (t: Task) => inRange(dueDay(t));
      const doneIn = (t: Task) => inRange(doneDay(t));
      items = pool.filter((t) => {
        switch (status) {
          case 'open': return isOpen(t) && dueIn(t);
          case 'overdue': return isOverdue(t, now) && dueIn(t);
          case 'done': return !isOpen(t) && (doneIn(t) || (!t.completedAt && dueIn(t)));
          default: return dueIn(t) || doneIn(t);
        }
      });
    } else {
      items = pool.filter((t) => {
        switch (status) {
          case 'overdue': return isOverdue(t, now);
          case 'done': return recentDone(t);
          case 'all': return isOpen(t) || recentDone(t);
          default: return isOpen(t);
        }
      });
    }
    items.sort(byRelevance);

    // Headline: who · when · what
    const who = person ? `👤 ${fullName(person)}` : '📋 Workspace';
    const period = from && to ? periodLabel(from, to, today) : null;
    const scope = {
      open: 'open',
      overdue: 'overdue',
      done: period ? 'finished' : `finished in the last ${RECENT_DONE_DAYS} days`,
      all: period ? 'due or finished' : `open or finished in the last ${RECENT_DONE_DAYS} days`,
    }[status];
    const when = period ? ` · ${period}` : '';

    if (!items.length) {
      const openTotal = pool.filter(isOpen).length;
      const hint = period && openTotal
        ? `\n${person ? fullName(person) : 'The workspace'} has ${openTotal} open work in total. Ask "pending work${person ? ` of ${person.firstName}` : ''}" to see it.`
        : '';
      return `${who}${when}\nNo work ${scope}.${hint}`;
    }

    // "3 work due or finished: 1 done, 2 open (1 overdue)"
    const summary = `${items.length} work ${scope}`;
    const overdue = items.filter((t) => isOverdue(t, now)).length;
    const detail = status === 'all' ? `: ${breakdown(items, now)}` : status === 'open' && overdue ? ` (${overdue} overdue)` : '';
    return `${who}${when}\n${summary}${detail}\n\n${list(items, now, names, !person)}`;
  }
}
