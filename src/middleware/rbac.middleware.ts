import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import { projectMembers } from '../db/schema/project_members';
import { roles } from '../db/schema/roles';
import { tasks } from '../db/schema/tasks';
import { eq, and } from 'drizzle-orm';
import { withTenant } from './tenant.middleware';

export const requirePermissions = (requiredPermissions: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const tenantId = req.user.tenantId;
    const userId = req.user.id;

    // Find projectId from request parameters, body, query or database lookup
    let projectId: string | undefined = (req.params?.projectId as string) || (req.body?.projectId as string) || (req.query?.projectId as string);

    // If param is ':id' and it's a project route
    if (!projectId && req.baseUrl.includes('projects') && req.params.id) {
      projectId = req.params.id as string;
    }

    // If param is ':id' and it's a task route, look up the task's projectId
    if (!projectId && req.baseUrl.includes('tasks') && req.params.id) {
      try {
        const [taskObj] = await withTenant(tenantId, async (tx) => {
          return tx.select({ projectId: tasks.projectId })
            .from(tasks)
            .where(and(eq(tasks.id, req.params.id as string), eq(tasks.tenantId, tenantId)));
        });
        if (taskObj) {
          projectId = taskObj.projectId || undefined;
        }
      } catch (err) {
        // Fallback
      }
    }

    let permissions = req.user.permissions;
    let roleName = req.user.role;

    // Fetch the user's role and permissions from DB to handle stale JWT tokens
    try {
      const dbRole = await withTenant(tenantId, async (tx) => {
        const [r] = await tx
          .select({
            name: roles.name,
            permissions: roles.permissions,
          })
          .from(roles)
          .where(eq(roles.id, req.user!.roleId));
        return r;
      });
      if (dbRole) {
        console.log(`[RBAC Debug] Found dbRole for user ${userId}: name=${dbRole.name}, permissions=`, dbRole.permissions);
        roleName = dbRole.name;
        permissions = dbRole.permissions;
      } else {
        console.log(`[RBAC Debug] dbRole not found for user ${userId} with roleId ${req.user!.roleId}`);
      }
    } catch (err) {
      // Fallback
    }

    if (projectId) {
      try {
        const projectMemberRole = await withTenant(tenantId, async (tx) => {
          const [member] = await tx
            .select({
              permissions: roles.permissions,
            })
            .from(projectMembers)
            .innerJoin(roles, eq(projectMembers.roleId, roles.id))
            .where(
              and(
                eq(projectMembers.tenantId, tenantId),
                eq(projectMembers.projectId, projectId),
                eq(projectMembers.userId, userId)
              )
            );
          return member ? member.permissions : null;
        });

        if (projectMemberRole) {
          permissions = projectMemberRole;
        }
      } catch (error) {
        // Fallback
      }
    }

    // Tenant Admin bypasses all checks or has admin: true
    if (roleName === 'Admin' || permissions['admin'] === true || req.user.permissions['admin'] === true) {
      return next();
    }

    const hasAll = requiredPermissions.every((perm) => permissions[perm] === true);

    if (!hasAll) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};
