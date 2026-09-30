import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '../../middleware/tenant.middleware';
import { tasks } from '../../db/schema/tasks';
import { users } from '../../db/schema/users';
import { matchMemberName } from '../../lib/names';
import { formatWorkId } from '../tasks/tasks.service';
import { formatDueLabel, zonedTimeToUtc } from '../calendar/task-schedule';
import { env } from '../../config/env';

/**
 * Answers work-status questions sent to the WhatsApp bot from a workspace's registered numbers
 * ("status W-96", "what is pending with Shreyas", "today's work", "what's overdue").
 * Read-only; every query is scoped to the sender's workspace.
 */

export type StatusQueryType = 'work_id' | 'person' | 'today' | 'overdue' | 'pending';

export interface StatusQuery {
  queryType: StatusQueryType;
  workNumber?: number | null;
  personName?: string | null;
}

type Task = typeof tasks.$inferSelect;
type Member = { id: string; firstName: string; lastName: string };

const FINISHED = ['done', 'completed', 'cancelled'];
const MAX_LINES = 10;

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

/** Today's date in the work time zone, 'YYYY-MM-DD' */
const todayKey = (now: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: env.WORK_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** The moment work is due: its due time, or the end of its due day when it has only a date */
function dueMoment(t: Task): Date | null {
  if (t.dueAt) return new Date(t.dueAt);
  const date = cf(t).dueDate;
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? zonedTimeToUtc(date, '23:59') : null;
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

/** Open work first by due moment (no due date last) */
const byDue = (a: Task, b: Task) =>
  (dueMoment(a)?.getTime() ?? Infinity) - (dueMoment(b)?.getTime() ?? Infinity);

function line(t: Task, now: Date, names: Map<string, string>, withDoer: boolean): string {
  const doer = withDoer ? ` · ${t.assigneeId ? names.get(t.assigneeId) ?? 'Unknown' : 'Unassigned'}` : '';
  const flag = isOverdue(t, now) ? ' ⚠️' : '';
  const due = formatDueLabel(t.customFields);
  return `• ${workId(t)} ${t.name}${doer} · ${statusLabel(t.status)}${due ? ` · ${due}` : ''}${flag}`;
}

function list(items: Task[], now: Date, names: Map<string, string>, withDoer: boolean): string {
  const shown = items.slice(0, MAX_LINES).map((t) => line(t, now, names, withDoer));
  if (items.length > MAX_LINES) shown.push(`…and ${items.length - MAX_LINES} more. See Work OS for the full list.`);
  return shown.join('\n');
}

export class WorkStatusService {
  /** The WhatsApp reply text for a status question. */
  static async answer(tenantId: string, query: StatusQuery, now: Date = new Date()): Promise<string> {
    const { work, members } = await withTenant(tenantId, async (tx) => ({
      work: (await tx.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt)))) as Task[],
      members: (await tx
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)))) as Member[],
    }));
    const names = new Map(members.map((m) => [m.id, fullName(m)]));

    switch (query.queryType) {
      case 'work_id': {
        const n = Number(query.workNumber);
        const t = Number.isInteger(n) && n > 0 ? work.find((w) => w.taskNumber === n) : undefined;
        if (!t) return Number.isInteger(n) && n > 0
          ? `I couldn't find W-${n} in your workspace.`
          : 'Which work? Send the work ID, for example "status W-96".';
        const fields = cf(t);
        return [
          `📋 ${workId(t)} · ${t.name}`,
          `👤 Doer: ${t.assigneeId ? names.get(t.assigneeId) ?? 'Unknown' : 'Unassigned'}`,
          `📌 Status: ${statusLabel(t.status)}`,
          `📅 Due: ${dueText(t, now)}`,
          fields.reviewerName ? `✅ Checks it: ${fields.reviewerName}` : null,
        ].filter(Boolean).join('\n');
      }

      case 'person': {
        const heard = (query.personName || '').trim();
        if (!heard) return 'Whose work? Send the employee\'s name, for example "pending work of Shreyas".';
        const match = matchMemberName(heard, members);
        if (match.kind === 'ambiguous') {
          return `Which ${heard}?\n${match.candidates.map((m) => `• ${fullName(m)}`).join('\n')}\n\nSend the full name.`;
        }
        if (match.kind === 'none') {
          const hint = match.suggestions.length ? ` Did you mean ${match.suggestions.map(fullName).join(' or ')}?` : '';
          return `I couldn't find "${heard}" in your workspace.${hint}`;
        }
        const person = fullName(match.member);
        const open = work.filter((t) => t.assigneeId === match.member.id && isOpen(t)).sort(byDue);
        if (!open.length) return `✅ ${person} has no open work.`;
        const overdue = open.filter((t) => isOverdue(t, now)).length;
        return `👤 ${person}: ${open.length} open${overdue ? `, ${overdue} overdue` : ''}\n${list(open, now, names, false)}`;
      }

      case 'today': {
        const today = todayKey(now);
        const due = work.filter((t) => cf(t).dueDate === today).sort(byDue);
        if (!due.length) return '📅 Nothing is due today.';
        const done = due.filter((t) => !isOpen(t)).length;
        const overdue = due.filter((t) => isOverdue(t, now)).length;
        return `📅 Due today: ${due.length} (${done} done${overdue ? `, ${overdue} overdue` : ''})\n${list(due, now, names, true)}`;
      }

      case 'overdue': {
        const late = work.filter((t) => isOverdue(t, now)).sort(byDue);
        if (!late.length) return '✅ No overdue work.';
        return `⚠️ Overdue: ${late.length}\n${list(late, now, names, true)}`;
      }

      case 'pending': {
        const open = work.filter(isOpen).sort(byDue);
        if (!open.length) return '✅ No open work.';
        const overdue = open.filter((t) => isOverdue(t, now)).length;
        // Who has the most open work
        const perPerson = new Map<string, number>();
        for (const t of open) {
          const who = t.assigneeId ? names.get(t.assigneeId) ?? 'Unknown' : 'Unassigned';
          perPerson.set(who, (perPerson.get(who) ?? 0) + 1);
        }
        const people = [...perPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([who, n]) => `${who} ${n}`).join(', ');
        return `📋 Open work: ${open.length}${overdue ? ` (${overdue} overdue)` : ''}\nBy person: ${people}\n\nDue soonest:\n${list(open, now, names, true)}`;
      }

      default:
        return 'I can tell you the status of work. Try "status W-96", "pending work of Shreyas", "today\'s work" or "what\'s overdue".';
    }
  }
}
