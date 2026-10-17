import { and, asc, between, desc, eq, gte, ilike, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema/users';
import { roles } from '../../db/schema/roles';
import { tasks } from '../../db/schema/tasks';
import { projects } from '../../db/schema/projects';
import { leaveRequests } from '../../db/schema/leave';
import { dueReminders } from '../../db/schema/due_reminders';
import { taskTimeLogs } from '../../db/schema/time_logs';
import { workReports } from '../../db/schema/work_reports';
import { workspaceClients, clientActivity } from '../../db/schema/workspace_clients';
import { chatGroups, chatGroupMembers, chatMessages } from '../../db/schema/chat_groups';
import { tenants } from '../../db/schema/tenants';
import { withTenant } from '../../middleware/tenant.middleware';
import { AttendanceService, localParts } from '../attendance/attendance.service';
import { formatWorkId } from '../tasks/tasks.service';

/**
 * Read-only views of one workspace for the MCP server. Every function takes the workspace (tenant) id that the
 * access key belongs to, so a key can never see another workspace. Lists are capped; people are given by name.
 */

export class McpInputError extends Error {}

export const MAX_ROWS = 500;
const cap = (n: number | undefined, def = 100) => Math.min(Math.max(1, Math.floor(n ?? def)), MAX_ROWS);
const fullName = (u: { firstName: string | null; lastName: string | null }) => `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
export const today = () => localParts(new Date()).day;
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const localDay = (d: Date | null) => (d ? localParts(new Date(d)).day : null);
const localTime = (d: Date | null) => (d ? `${localParts(new Date(d)).day} ${localParts(new Date(d)).hhmm}` : null);
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

interface Person { id: string; name: string; email: string; role: string; active: boolean; reportsTo: string | null; joinedOn: string | null }

async function people(tenantId: string): Promise<Person[]> {
  const rows = await withTenant<any[]>(tenantId, (tx) =>
    tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, role: roles.name, deletedAt: users.deletedAt, reportsTo: users.reportsTo, createdAt: users.createdAt })
      .from(users).leftJoin(roles, eq(roles.id, users.roleId)).where(eq(users.tenantId, tenantId)),
  );
  return rows.map((r) => ({
    id: r.id, name: fullName(r), email: r.deletedAt ? '' : r.email, role: r.role ?? '', active: !r.deletedAt, reportsTo: r.reportsTo, joinedOn: localDay(r.createdAt),
  }));
}

/** The people whose name or email matches (active members first); an error when nobody matches */
async function findPeople(tenantId: string, query: string): Promise<Person[]> {
  const q = query.trim().toLowerCase();
  const all = (await people(tenantId)).filter((p) => p.active);
  const exact = all.filter((p) => p.name.toLowerCase() === q || p.email.toLowerCase() === q);
  const found = exact.length ? exact : all.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
  if (!found.length) throw new McpInputError(`Nobody in this workspace matches "${query}". Use list_people to see the names.`);
  return found;
}

async function nameMap(tenantId: string) {
  return new Map((await people(tenantId)).map((p) => [p.id, p.name]));
}

function checkDay(label: string, v: string | undefined) {
  if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new McpInputError(`${label} must be a date like 2026-10-17`);
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export async function workspaceOverview(tenantId: string, sections: Set<string>) {
  const day = today();
  const [ws] = await db.select({ name: tenants.name, slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const members = (await people(tenantId)).filter((p) => p.active);
  const out: Record<string, unknown> = { workspace: ws?.name, workspaceId: ws?.slug, date: day, members: members.length };
  if (sections.has('tasks')) {
    const now = new Date();
    const rows = await withTenant<any[]>(tenantId, (tx) =>
      tx.select({ status: tasks.status, dueAt: tasks.dueAt, completedAt: tasks.completedAt }).from(tasks).where(and(eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt))),
    );
    const byStatus: Record<string, number> = {};
    rows.forEach((r) => { byStatus[r.status] = (byStatus[r.status] ?? 0) + 1; });
    out.tasks = {
      byStatus,
      overdue: rows.filter((r) => r.status !== 'done' && r.dueAt && new Date(r.dueAt) < now).length,
      doneToday: rows.filter((r) => r.completedAt && localDay(r.completedAt) === day).length,
    };
  }
  if (sections.has('projects')) {
    const p = await withTenant<any[]>(tenantId, (tx) => tx.select({ status: projects.status }).from(projects).where(and(eq(projects.tenantId, tenantId), isNull(projects.deletedAt))));
    out.projects = { total: p.length, active: p.filter((x) => x.status === 'active').length, completed: p.filter((x) => x.status === 'completed').length };
  }
  if (sections.has('attendance')) {
    const d = await AttendanceService.day(tenantId, day);
    const counts: Record<string, number> = {};
    d.people.forEach((p) => { counts[p.state] = (counts[p.state] ?? 0) + 1; });
    out.attendanceToday = { holiday: d.holiday, counts };
  }
  if (sections.has('leave')) {
    const pending = await db.select({ n: sql<number>`count(*)::int` }).from(leaveRequests).where(and(eq(leaveRequests.tenantId, tenantId), inArray(leaveRequests.status, ['pending_manager', 'pending_admin'] as any)));
    const onLeave = await db.select({ n: sql<number>`count(*)::int` }).from(leaveRequests).where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.status, 'approved' as any), lte(leaveRequests.fromDay, day), gte(leaveRequests.toDay, day)));
    out.leave = { waitingForApproval: pending[0]?.n ?? 0, onLeaveToday: onLeave[0]?.n ?? 0 };
  }
  if (sections.has('reminders')) {
    const r = await db.select({ dueDate: dueReminders.dueDate }).from(dueReminders).where(and(eq(dueReminders.tenantId, tenantId), eq(dueReminders.status, 'active' as any)));
    out.reminders = { overdue: r.filter((x) => x.dueDate < day).length, dueIn7Days: r.filter((x) => x.dueDate >= day && x.dueDate <= addDays(day, 7)).length };
  }
  if (sections.has('clients')) {
    const c = await db.select({ status: workspaceClients.status }).from(workspaceClients).where(and(eq(workspaceClients.tenantId, tenantId), isNull(workspaceClients.archivedAt)));
    out.clients = { total: c.length, active: c.filter((x) => x.status === 'active').length };
  }
  return out;
}

export async function listPeople(tenantId: string, includeRemoved = false) {
  const all = await people(tenantId);
  const names = new Map(all.map((p) => [p.id, p.name]));
  return all.filter((p) => includeRemoved || p.active).map((p) => ({
    name: p.name, email: p.email, role: p.role, reportsTo: p.reportsTo ? names.get(p.reportsTo) ?? null : null, joinedOn: p.joinedOn, ...(includeRemoved ? { active: p.active } : {}),
  }));
}

// ─── Projects and tasks ───────────────────────────────────────────────────────

export async function listProjects(tenantId: string, opts: { status?: string; client?: string; search?: string; limit?: number }) {
  return withTenant(tenantId, async (tx: any) => {
    const rows = await tx.select().from(projects).where(and(
      eq(projects.tenantId, tenantId), isNull(projects.deletedAt),
      opts.status ? eq(projects.status, opts.status) : undefined,
      opts.client ? ilike(projects.clientName, like(opts.client)) : undefined,
      opts.search ? or(ilike(projects.name, like(opts.search)), ilike(projects.description, like(opts.search))) : undefined,
    )).orderBy(desc(projects.createdAt)).limit(cap(opts.limit));
    const ids = rows.map((r: any) => r.id);
    const counts = ids.length ? await tx.select({
      projectId: tasks.projectId,
      open: sql<number>`count(*) filter (where ${tasks.status} <> 'done')::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
    }).from(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.projectId, ids), isNull(tasks.deletedAt))).groupBy(tasks.projectId) : [];
    const byId = new Map(counts.map((c: any) => [c.projectId, c]));
    const names = await nameMap(tenantId);
    return rows.map((p: any) => ({
      id: p.id, name: p.name, client: p.clientName ?? 'Company Projects', status: p.status, projectManager: p.pmId ? names.get(p.pmId) ?? null : null,
      openTasks: (byId.get(p.id) as any)?.open ?? 0, doneTasks: (byId.get(p.id) as any)?.done ?? 0, createdOn: localDay(p.createdAt),
      description: p.description ? String(p.description).slice(0, 500) : null,
    }));
  });
}

function taskView(t: any, names: Map<string, string>, projectNames: Map<string, string>) {
  const cf = (t.customFields ?? {}) as Record<string, any>;
  return {
    workId: formatWorkId(t.taskNumber) ?? t.id,
    name: t.name,
    status: t.status,
    assignee: t.assigneeId ? names.get(t.assigneeId) ?? null : null,
    assignedBy: t.assignedBy ? names.get(t.assignedBy) ?? null : null,
    project: t.projectId ? projectNames.get(t.projectId) ?? null : null,
    priority: cf.priority ?? null,
    due: t.dueAt ? localTime(t.dueAt) : cf.dueDate ?? null,
    overdue: t.status !== 'done' && !!t.dueAt && new Date(t.dueAt) < new Date(),
    estimateHours: t.timeEstimate ?? null,
    createdOn: localDay(t.createdAt),
    completedAt: localTime(t.completedAt),
  };
}

export async function listTasks(tenantId: string, opts: {
  person?: string; status?: string; project?: string; overdue?: boolean; dueFrom?: string; dueTo?: string; completedFrom?: string; completedTo?: string; search?: string; limit?: number;
}) {
  ['dueFrom', 'dueTo', 'completedFrom', 'completedTo'].forEach((k) => checkDay(k, (opts as any)[k]));
  const who = opts.person ? (await findPeople(tenantId, opts.person)).map((p) => p.id) : null;
  return withTenant(tenantId, async (tx: any) => {
    let projectIds: string[] | null = null;
    if (opts.project) {
      const ps = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.tenantId, tenantId), ilike(projects.name, like(opts.project))));
      projectIds = ps.map((p: any) => p.id);
      if (!projectIds!.length) throw new McpInputError(`No project matches "${opts.project}". Use list_projects to see them.`);
    }
    const rows = await tx.select().from(tasks).where(and(
      eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt),
      who ? inArray(tasks.assigneeId, who) : undefined,
      opts.status ? eq(tasks.status, opts.status) : undefined,
      projectIds ? inArray(tasks.projectId, projectIds) : undefined,
      opts.overdue ? and(ne(tasks.status, 'done'), lt(tasks.dueAt, new Date())) : undefined,
      opts.dueFrom ? gte(tasks.dueAt, new Date(`${opts.dueFrom}T00:00:00+05:30`)) : undefined,
      opts.dueTo ? lt(tasks.dueAt, new Date(`${addDays(opts.dueTo, 1)}T00:00:00+05:30`)) : undefined,
      opts.completedFrom ? gte(tasks.completedAt, new Date(`${opts.completedFrom}T00:00:00+05:30`)) : undefined,
      opts.completedTo ? lt(tasks.completedAt, new Date(`${addDays(opts.completedTo, 1)}T00:00:00+05:30`)) : undefined,
      opts.search ? or(ilike(tasks.name, like(opts.search)), ilike(tasks.description, like(opts.search))) : undefined,
    )).orderBy(desc(tasks.createdAt)).limit(cap(opts.limit));
    const pids = [...new Set(rows.map((r: any) => r.projectId).filter(Boolean))] as string[];
    const ps = pids.length ? await tx.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, pids)) : [];
    const names = await nameMap(tenantId);
    const projectNames = new Map<string, string>(ps.map((p: any) => [p.id, p.name]));
    return { count: rows.length, tasks: rows.map((t: any) => taskView(t, names, projectNames)) };
  });
}

export async function getTask(tenantId: string, workId: string) {
  const n = Number(String(workId).replace(/^\s*w-?\s*/i, ''));
  return withTenant(tenantId, async (tx: any) => {
    const [t] = await tx.select().from(tasks).where(and(
      eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt),
      Number.isInteger(n) && n > 0 ? eq(tasks.taskNumber, n) : eq(tasks.name, workId),
    )).limit(1);
    if (!t) throw new McpInputError(`No work item ${workId}. Use list_tasks to find it.`);
    const names = await nameMap(tenantId);
    const [p] = t.projectId ? await tx.select({ name: projects.name }).from(projects).where(eq(projects.id, t.projectId)).limit(1) : [];
    const logs = await db.select().from(taskTimeLogs).where(and(eq(taskTimeLogs.tenantId, tenantId), eq(taskTimeLogs.taskId, t.id))).orderBy(desc(taskTimeLogs.workDate));
    return {
      ...taskView(t, names, new Map(p ? [[t.projectId, p.name]] : [])),
      description: t.description ?? null,
      subtasks: Array.isArray((t.customFields as any)?.subtasks) ? (t.customFields as any).subtasks.map((s: any) => ({ title: s.title ?? s.name, done: !!(s.completed ?? s.done) })) : [],
      timeLogged: { totalMinutes: logs.reduce((s, l) => s + l.minutes, 0), entries: logs.map((l) => ({ date: l.workDate, minutes: l.minutes, by: names.get(l.userId) ?? null, note: l.note })) },
    };
  });
}

// ─── Attendance and leave ─────────────────────────────────────────────────────

export async function attendanceDay(tenantId: string, date?: string) {
  checkDay('date', date);
  const d = await AttendanceService.day(tenantId, date ?? today());
  return {
    date: d.day,
    holiday: d.holiday,
    people: d.people.map((p) => ({
      name: p.name,
      state: p.state,
      early: p.record?.early ?? false,
      checkIn: p.record?.checkInAt ? localParts(new Date(p.record.checkInAt)).hhmm : null,
      place: p.record?.locationName || null,
      halfDayLeave: p.record?.leaveHalf ?? null,
      note: p.record?.note ?? null,
    })),
  };
}

export async function attendanceMonth(tenantId: string, month?: string, person?: string) {
  const m = month ?? today().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new McpInputError('month must look like 2026-10');
  const only = person ? (await findPeople(tenantId, person))[0] : null;
  const r = await AttendanceService.month(tenantId, m, only?.id);
  return {
    month: m,
    holidays: r.holidays.map((h: any) => ({ date: h.day, name: h.name })),
    people: r.people.map((p) => ({
      name: p.name,
      totals: p.totals,
      ...(only ? { days: p.days.map((d) => ({ date: d.day, state: d.state, checkIn: d.checkInAt ? localParts(new Date(d.checkInAt)).hhmm : null })) } : {}),
    })),
  };
}

export async function listLeave(tenantId: string, opts: { status?: string; person?: string; from?: string; to?: string; limit?: number }) {
  checkDay('from', opts.from); checkDay('to', opts.to);
  const who = opts.person ? (await findPeople(tenantId, opts.person)).map((p) => p.id) : null;
  const rows = await db.select().from(leaveRequests).where(and(
    eq(leaveRequests.tenantId, tenantId),
    opts.status ? eq(leaveRequests.status, opts.status as any) : undefined,
    who ? inArray(leaveRequests.userId, who) : undefined,
    opts.from ? gte(leaveRequests.toDay, opts.from) : undefined,
    opts.to ? lte(leaveRequests.fromDay, opts.to) : undefined,
  )).orderBy(desc(leaveRequests.fromDay)).limit(cap(opts.limit));
  const names = await nameMap(tenantId);
  return rows.map((l) => ({
    person: names.get(l.userId) ?? null, from: l.fromDay, to: l.toDay, days: l.days, halfDay: l.halfDay, reason: l.reason, status: l.status,
    managerDecisionBy: l.managerBy ? names.get(l.managerBy) ?? null : null, adminDecisionBy: l.adminBy ? names.get(l.adminBy) ?? null : null,
    appliedOn: localDay(l.createdAt),
  }));
}

// ─── Hours and work reports ───────────────────────────────────────────────────

export async function hoursWorked(tenantId: string, opts: { from?: string; to?: string; person?: string; withEntries?: boolean }) {
  const to = opts.to ?? today();
  const from = opts.from ?? addDays(to, -6);
  checkDay('from', from); checkDay('to', to);
  if (to < from) throw new McpInputError('to is before from');
  if (addDays(from, 62) < to) throw new McpInputError('Choose at most two months');
  const who = opts.person ? (await findPeople(tenantId, opts.person)).map((p) => p.id) : null;
  const logs = await db.select().from(taskTimeLogs).where(and(
    eq(taskTimeLogs.tenantId, tenantId), between(taskTimeLogs.workDate, from, to), who ? inArray(taskTimeLogs.userId, who) : undefined,
  )).orderBy(asc(taskTimeLogs.workDate));
  const working = new Set(await AttendanceService.workingDays(tenantId, from, to));
  const names = await nameMap(tenantId);
  const taskIds = [...new Set(logs.map((l) => l.taskId))];
  const taskRows = taskIds.length ? await withTenant<any[]>(tenantId, (tx) => tx.select({ id: tasks.id, name: tasks.name, n: tasks.taskNumber }).from(tasks).where(inArray(tasks.id, taskIds))) : [];
  const taskNames = new Map(taskRows.map((t) => [t.id, `${formatWorkId(t.n) ?? ''} ${t.name}`.trim()]));
  const byPerson = new Map<string, Map<string, { minutes: number; entries: unknown[] }>>();
  for (const l of logs) {
    const days = byPerson.get(l.userId) ?? new Map();
    const d = days.get(l.workDate) ?? { minutes: 0, entries: [] };
    d.minutes += l.minutes;
    d.entries.push({ task: taskNames.get(l.taskId) ?? null, minutes: l.minutes, note: l.note });
    days.set(l.workDate, d);
    byPerson.set(l.userId, days);
  }
  const ids = who ?? [...byPerson.keys()];
  return {
    from, to, fullDayMinutes: 480,
    people: ids.map((id) => {
      const days = byPerson.get(id) ?? new Map();
      const list = [...days.entries()].map(([date, d]) => ({ date, minutes: d.minutes, underEightHours: working.has(date) && d.minutes < 480, ...(opts.withEntries ? { entries: d.entries } : {}) }));
      return { name: names.get(id) ?? null, totalMinutes: list.reduce((s, d) => s + d.minutes, 0), days: list };
    }),
  };
}

export async function listWorkReports(tenantId: string, opts: { person: string; from?: string; to?: string; limit?: number }) {
  checkDay('from', opts.from); checkDay('to', opts.to);
  const found = await findPeople(tenantId, opts.person);
  const keys = found.flatMap((p) => [p.id, p.email.toLowerCase()]).filter(Boolean);
  const rows = await db.select().from(workReports).where(and(
    eq(workReports.tenantId, tenantId), inArray(workReports.employeeId, keys),
    opts.from ? gte(sql`coalesce(${workReports.workDate}, ${workReports.createdAt}::date)`, opts.from) : undefined,
    opts.to ? lte(sql`coalesce(${workReports.workDate}, ${workReports.createdAt}::date)`, opts.to) : undefined,
  )).orderBy(desc(workReports.createdAt)).limit(cap(opts.limit, 50));
  return rows.map((r) => ({
    person: found.find((p) => p.id === r.employeeId || p.email.toLowerCase() === r.employeeId.toLowerCase())?.name ?? null,
    date: r.workDate ?? localDay(r.createdAt), title: r.title, report: r.reportText, minutes: r.minutes ?? null, by: r.authorName, document: r.documentName ?? null,
  }));
}

// ─── Clients and reminders ────────────────────────────────────────────────────

export async function listClients(tenantId: string, opts: { status?: string; search?: string; limit?: number }) {
  const rows = await db.select().from(workspaceClients).where(and(
    eq(workspaceClients.tenantId, tenantId), isNull(workspaceClients.archivedAt),
    opts.status ? eq(workspaceClients.status, opts.status as any) : undefined,
    opts.search ? or(ilike(workspaceClients.name, like(opts.search)), ilike(workspaceClients.city, like(opts.search)), ilike(workspaceClients.contactPerson, like(opts.search))) : undefined,
  )).orderBy(asc(workspaceClients.name)).limit(cap(opts.limit));
  const names = await nameMap(tenantId);
  return rows.map((c) => ({
    name: c.name, status: c.status, contactPerson: c.contactPerson, phone: c.phone, email: c.email, city: c.city, category: c.category,
    accountManager: c.accountManagerId ? names.get(c.accountManagerId) ?? null : null, clientSince: c.clientSince, tags: c.tags,
  }));
}

export async function getClient(tenantId: string, name: string) {
  const [c] = await db.select().from(workspaceClients).where(and(eq(workspaceClients.tenantId, tenantId), isNull(workspaceClients.archivedAt), ilike(workspaceClients.name, like(name)))).limit(1);
  if (!c) throw new McpInputError(`No client matches "${name}". Use list_clients to see them.`);
  const names = await nameMap(tenantId);
  const notes = await db.select().from(clientActivity).where(and(eq(clientActivity.clientId, c.id), eq(clientActivity.kind, 'note'))).orderBy(desc(clientActivity.createdAt)).limit(20);
  const projs = await listProjects(tenantId, {}).then((ps) => ps.filter((p: any) => p.client === c.name));
  return {
    name: c.name, status: c.status, contactPerson: c.contactPerson, phone: c.phone, email: c.email, city: c.city, address: c.address, gstNumber: c.gstNumber,
    category: c.category, accountManager: c.accountManagerId ? names.get(c.accountManagerId) ?? null : null, clientSince: c.clientSince, about: c.notes, tags: c.tags,
    projects: projs.map((p: any) => ({ name: p.name, status: p.status, openTasks: p.openTasks, doneTasks: p.doneTasks })),
    recentNotes: notes.map((n) => ({ date: localDay(n.createdAt), by: n.actorId ? names.get(n.actorId) ?? null : null, note: n.body })),
  };
}

export async function listReminders(tenantId: string, opts: { status?: string; dueBefore?: string; limit?: number }) {
  checkDay('dueBefore', opts.dueBefore);
  const rows = await db.select().from(dueReminders).where(and(
    eq(dueReminders.tenantId, tenantId),
    eq(dueReminders.status, (opts.status ?? 'active') as any),
    opts.dueBefore ? lte(dueReminders.dueDate, opts.dueBefore) : undefined,
  )).orderBy(asc(dueReminders.dueDate)).limit(cap(opts.limit));
  const names = await nameMap(tenantId);
  const day = today();
  return rows.map((r) => ({
    title: r.title, category: r.category, amountRupees: r.amount != null ? Number(r.amount) : null, dueDate: r.dueDate, overdue: r.status === 'active' && r.dueDate < day,
    repeats: r.repeat, owner: r.ownerId ? names.get(r.ownerId) ?? null : null, status: r.status,
    completedAt: localTime(r.completedAt), completedBy: r.completedBy ? names.get(r.completedBy) ?? null : null, report: r.report,
  }));
}

// ─── Groups ───────────────────────────────────────────────────────────────────

export async function listGroups(tenantId: string) {
  const groups = await db.select().from(chatGroups).where(and(eq(chatGroups.tenantId, tenantId), isNull(chatGroups.archivedAt))).orderBy(desc(chatGroups.lastMessageAt));
  const counts = groups.length ? await db.select({ groupId: chatGroupMembers.groupId, n: sql<number>`count(*)::int` }).from(chatGroupMembers).where(inArray(chatGroupMembers.groupId, groups.map((g) => g.id))).groupBy(chatGroupMembers.groupId) : [];
  const byId = new Map(counts.map((c) => [c.groupId, c.n]));
  return groups.map((g) => ({ name: g.name, description: g.description, members: byId.get(g.id) ?? 0, lastMessageAt: localTime(g.lastMessageAt) }));
}

export async function groupMessages(tenantId: string, opts: { group: string; date?: string; limit?: number }) {
  checkDay('date', opts.date);
  const [g] = await db.select().from(chatGroups).where(and(eq(chatGroups.tenantId, tenantId), isNull(chatGroups.archivedAt), ilike(chatGroups.name, like(opts.group)))).limit(1);
  if (!g) throw new McpInputError(`No group matches "${opts.group}". Use list_groups to see them.`);
  const rows = await db.select().from(chatMessages).where(and(
    eq(chatMessages.groupId, g.id), isNull(chatMessages.deletedAt),
    opts.date ? and(gte(chatMessages.createdAt, new Date(`${opts.date}T00:00:00+05:30`)), lt(chatMessages.createdAt, new Date(`${addDays(opts.date, 1)}T00:00:00+05:30`))) : undefined,
  )).orderBy(desc(chatMessages.createdAt)).limit(cap(opts.limit));
  const names = await nameMap(tenantId);
  return {
    group: g.name,
    messages: rows.reverse().map((m) => ({
      at: localTime(m.createdAt), from: m.senderId ? names.get(m.senderId) ?? null : null, text: m.body,
      files: m.attachments.map((a) => (a.voice ? 'Voice message' : a.name)), pinned: !!m.pinnedAt,
    })),
  };
}

