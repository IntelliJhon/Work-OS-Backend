import { Response, NextFunction } from 'express';
import { db } from '../../db';
import { projectMembers } from '../../db/schema/project_members';
import { users } from '../../db/schema/users';
import { roles } from '../../db/schema/roles';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { eq, and } from 'drizzle-orm';

export class ProjectMembersController {
  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.projectId as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await tx
          .select({
            id: projectMembers.id,
            userId: projectMembers.userId,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            roleId: projectMembers.roleId,
            roleName: roles.name,
            createdAt: projectMembers.createdAt,
          })
          .from(projectMembers)
          .innerJoin(users, eq(projectMembers.userId, users.id))
          .innerJoin(roles, eq(projectMembers.roleId, roles.id))
          .where(
            and(
              eq(projectMembers.tenantId, tenantId),
              eq(projectMembers.projectId, projectId)
            )
          );
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async add(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.projectId as string;
      const { userId, roleId } = req.body;

      const result = await withTenant(tenantId, async (tx) => {
        // Check if member already exists
        const [existing] = await tx
          .select()
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.tenantId, tenantId),
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, userId)
            )
          );

        if (existing) {
          throw new Error('User is already a member of this project');
        }

        const [newMember] = await tx
          .insert(projectMembers)
          .values({
            tenantId,
            projectId,
            userId,
            roleId,
          })
          .returning();

        const [userObj] = await tx.select().from(users).where(eq(users.id, userId));
        const [roleObj] = await tx.select().from(roles).where(eq(roles.id, roleId));

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'INSERT',
          tableName: 'project_members',
          recordId: newMember.id,
          newValue: newMember,
          ipAddress: req.ip,
        }, tx);

        return {
          ...newMember,
          email: userObj.email,
          firstName: userObj.firstName,
          lastName: userObj.lastName,
          roleName: roleObj.name,
        };
      });

      return res.status(201).json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error.message || 'Failed to add member' });
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.projectId as string;
      const userId = req.params.userId as string;
      const { roleId } = req.body;

      const result = await withTenant(tenantId, async (tx) => {
        const [oldMember] = await tx
          .select()
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.tenantId, tenantId),
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, userId)
            )
          );

        if (!oldMember) {
          throw new Error('Project membership not found');
        }

        const [updatedMember] = await tx
          .update(projectMembers)
          .set({
            roleId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(projectMembers.tenantId, tenantId),
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, userId)
            )
          )
          .returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'UPDATE',
          tableName: 'project_members',
          recordId: updatedMember.id,
          oldValue: oldMember,
          newValue: updatedMember,
          ipAddress: req.ip,
        }, tx);

        return updatedMember;
      });

      return res.json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }

  static async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.projectId as string;
      const userId = req.params.userId as string;

      await withTenant(tenantId, async (tx) => {
        const [oldMember] = await tx
          .select()
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.tenantId, tenantId),
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, userId)
            )
          );

        if (!oldMember) {
          throw new Error('Project membership not found');
        }

        await tx
          .delete(projectMembers)
          .where(
            and(
              eq(projectMembers.tenantId, tenantId),
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, userId)
            )
          );

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'DELETE',
          tableName: 'project_members',
          recordId: oldMember.id,
          oldValue: oldMember,
          ipAddress: req.ip,
        }, tx);
      });

      return res.status(204).send();
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }
}
