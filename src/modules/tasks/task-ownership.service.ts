import { and, eq } from 'drizzle-orm';
import { tasks } from '../../db/schema/tasks';
import { projects } from '../../db/schema/projects';
import { projectMembers } from '../../db/schema/project_members';
import { roles } from '../../db/schema/roles';
import { users } from '../../db/schema/users';
import { ForbiddenError } from '../../errors/workflow.errors';

export type AccessLevel = 'admin' | 'project_manager' | 'assignee' | 'none';

export class TaskOwnershipService {
  /**
   * Resolves the access level of a user for a specific task.
   */
  static async getAccessLevel(
    tx: any,
    tenantId: string,
    userId: string,
    userRole: string,
    userPermissions: Record<string, boolean>,
    taskId: string,
  ): Promise<AccessLevel> {
    // Fetch user and role dynamically from DB to prevent stale JWT issues
    let activeRole = userRole;
    let activePermissions = userPermissions || {};

    try {
      const [dbUserRole] = await tx
        .select({
          name: roles.name,
          permissions: roles.permissions,
        })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      if (dbUserRole) {
        activeRole = dbUserRole.name;
        activePermissions = dbUserRole.permissions || {};
      }
    } catch (err) {
      // Fallback on error
    }

    // 1. Admin role check (global system-wide admin)
    if (activeRole === 'Admin' || activePermissions?.admin === true) {
      return 'admin';
    }

    // 2. Project Manager global role check
    if (activeRole === 'Project Manager') {
      return 'project_manager';
    }

    // Fetch the task and the project's pmId
    const [taskWithProject] = await tx
      .select({
        assigneeId: tasks.assigneeId,
        projectId: tasks.projectId,
        pmId: projects.pmId,
      })
      .from(tasks)
      .leftJoin(projects, eq(tasks.projectId, projects.id))
      .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));

    if (!taskWithProject) {
      return 'none';
    }

    // 3. Project Manager check - direct project owner
    if (taskWithProject.pmId === userId) {
      return 'project_manager';
    }

    // 4. Project Manager check via project membership (if their project role name is 'Project Manager', 'ProjectManager' or 'Admin')
    const [member] = await tx
      .select({ roleName: roles.name })
      .from(projectMembers)
      .innerJoin(roles, eq(projectMembers.roleId, roles.id))
      .where(
        and(
          eq(projectMembers.projectId, taskWithProject.projectId),
          eq(projectMembers.userId, userId),
          eq(projectMembers.tenantId, tenantId),
        ),
      );

    if (member && (member.roleName === 'Project Manager' || member.roleName === 'ProjectManager' || member.roleName === 'Admin')) {
      return 'project_manager';
    }

    // 5. Assignee check
    if (taskWithProject.assigneeId === userId) {
      return 'assignee';
    }

    return 'none';
  }

  /**
   * Strictly validates that standard assignees do not mutate restricted fields.
   */
  static validateAssigneeUpdates(payload: Record<string, any>, dbTask: any) {
    const restrictedTopFields = ['assigneeId', 'sprintId', 'activityId', 'projectId', 'storyId', 'name', 'description'];
    for (const field of restrictedTopFields) {
      if (payload[field] !== undefined && payload[field] !== dbTask[field]) {
        throw new ForbiddenError('You are not allowed to update this task');
      }
    }

    if (payload.customFields !== undefined) {
      const payloadCf = payload.customFields || {};
      const dbCf = dbTask.customFields || {};

      const allowedCustomKeys = ['subtasks', 'progress'];
      const allCfKeys = Array.from(new Set([...Object.keys(payloadCf), ...Object.keys(dbCf)]));

      for (const key of allCfKeys) {
        if (!allowedCustomKeys.includes(key)) {
          if (JSON.stringify(payloadCf[key]) !== JSON.stringify(dbCf[key])) {
            throw new ForbiddenError('You are not allowed to update this task');
          }
        }
      }
    }
  }

  /**
   * Filters payload to ensure only permitted status, progress, and checklist subtasks are saved for assignees.
   */
  static filterAllowedUpdates(
    accessLevel: AccessLevel,
    payload: Record<string, any>,
    dbTask: any,
  ): Record<string, any> {
    if (accessLevel === 'admin' || accessLevel === 'project_manager') {
      return payload;
    }
    if (accessLevel === 'assignee') {
      const allowed: Record<string, any> = {};
      if (payload.status !== undefined) {
        allowed.status = payload.status;
      }

      const dbCf = dbTask.customFields || {};
      const payloadCf = payload.customFields || {};
      const updatedCf = { ...dbCf };

      let hasCustomFieldsUpdate = false;
      if (payloadCf.subtasks !== undefined) {
        updatedCf.subtasks = payloadCf.subtasks;
        hasCustomFieldsUpdate = true;
      }
      if (payloadCf.progress !== undefined) {
        updatedCf.progress = payloadCf.progress;
        hasCustomFieldsUpdate = true;
      }

      if (hasCustomFieldsUpdate) {
        allowed.customFields = updatedCf;
      }

      return allowed;
    }
    return {};
  }
}
