import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { tasks } from '../../db/schema/tasks';
import { projects } from '../../db/schema/projects';
import { projectMembers } from '../../db/schema/project_members';
import { roles } from '../../db/schema/roles';
import { users } from '../../db/schema/users';

/**
 * Which work items a person may see. Admins, Project Managers (role, or project.manage) see everything.
 * Everyone else sees the work assigned to them, the work they assigned to someone, and all work in the projects
 * they manage (the project's PM, or a Project Manager/Admin in its member list).
 */
export interface TaskScope {
  all: boolean;
  userId: string;
  managedProjectIds: string[];
}

const PM_ROLE_NAMES = ['Project Manager', 'ProjectManager', 'Admin'];

export async function taskScope(tx: any, tenantId: string, userId: string): Promise<TaskScope> {
  const [me] = await tx
    .select({ roleName: roles.name, permissions: roles.permissions })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .limit(1);
  const permissions = (me?.permissions ?? {}) as Record<string, boolean>;
  if (me && (me.roleName === 'Admin' || me.roleName === 'Project Manager' || permissions.admin === true || permissions['project.manage'] === true)) {
    return { all: true, userId, managedProjectIds: [] };
  }
  const owned: { id: string }[] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), eq(projects.pmId, userId)));
  const managed: { id: string }[] = await tx
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(roles, eq(projectMembers.roleId, roles.id))
    .where(and(eq(projectMembers.tenantId, tenantId), eq(projectMembers.userId, userId), inArray(roles.name, PM_ROLE_NAMES)));
  return { all: false, userId, managedProjectIds: [...new Set([...owned, ...managed].map((p) => p.id))] };
}

/** The WHERE condition for the work items in scope (undefined = everything) */
export function visibleTasks(scope: TaskScope): SQL | undefined {
  if (scope.all) return undefined;
  return or(
    eq(tasks.assigneeId, scope.userId),
    eq(tasks.assignedBy, scope.userId),
    scope.managedProjectIds.length ? inArray(tasks.projectId, scope.managedProjectIds) : undefined,
  );
}

/** Whether one work item is in scope */
export function canSeeTask(scope: TaskScope, task: { assigneeId: string | null; assignedBy: string | null; projectId: string | null }) {
  return scope.all
    || task.assigneeId === scope.userId
    || task.assignedBy === scope.userId
    || (!!task.projectId && scope.managedProjectIds.includes(task.projectId));
}
