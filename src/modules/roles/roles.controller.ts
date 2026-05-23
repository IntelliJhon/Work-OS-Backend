import { Response, NextFunction } from 'express';
import { roles } from '../../db/schema/roles';
import { users } from '../../db/schema/users';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { eq, and, sql } from 'drizzle-orm';
import { getIoInstance } from '../../socket/socketServer';
import { getTenantRoom } from '../../socket/tenantRooms';

export class RolesController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      // Prevent privilege escalation
      if (req.user!.permissions['admin'] !== true) {
        const actorPerms = req.user!.permissions;
        const requestedPerms = req.body.permissions as Record<string, boolean>;
        if (requestedPerms) {
          for (const [perm, val] of Object.entries(requestedPerms)) {
            if (val === true && actorPerms[perm] !== true) {
              return res.status(403).json({ error: 'Privilege escalation prevention: Cannot grant permissions you do not possess.' });
            }
          }
        }
      }

      const result = await withTenant(tenantId, async (tx) => {
        const [newRole] = await tx.insert(roles).values({
          tenantId,
          ...req.body,
        }).returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'INSERT',
          tableName: 'roles',
          recordId: newRole.id,
          newValue: newRole,
          ipAddress: req.ip,
        }, tx);

        return newRole;
      });

      getIoInstance().to(getTenantRoom(tenantId)).emit('role_updated', { roleId: result.id });

      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        const listWithCount = await tx
          .select({
            id: roles.id,
            tenantId: roles.tenantId,
            name: roles.name,
            permissions: roles.permissions,
            createdAt: roles.createdAt,
            updatedAt: roles.updatedAt,
            userCount: sql<number>`count(${users.id})::int`,
          })
          .from(roles)
          .leftJoin(users, eq(roles.id, users.roleId))
          .where(eq(roles.tenantId, tenantId))
          .groupBy(roles.id);
        return listWithCount;
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const roleId = req.params.id as string;

      // Prevent privilege escalation
      if (req.user!.permissions['admin'] !== true) {
        const actorPerms = req.user!.permissions;
        const requestedPerms = req.body.permissions as Record<string, boolean>;
        if (requestedPerms) {
          for (const [perm, val] of Object.entries(requestedPerms)) {
            if (val === true && actorPerms[perm] !== true) {
              return res.status(403).json({ error: 'Privilege escalation prevention: Cannot grant permissions you do not possess.' });
            }
          }
        }
      }

      const result = await withTenant(tenantId, async (tx) => {
        // Get old role for audit
        const [oldRole] = await tx.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));
        
        if (!oldRole) {
          throw new Error('Role not found');
        }

        // Prevent disabling admin on the Tenant Admin role if it leaves no admins
        if (oldRole.name === 'Tenant Admin' && req.body.permissions?.admin === false) {
          const admins = await tx
            .select()
            .from(users)
            .where(and(eq(users.roleId, roleId), eq(users.tenantId, tenantId)));
          if (admins.length > 0) {
            throw new Error('Cannot remove admin permissions from Tenant Admin role while it is active');
          }
        }

        const [updatedRole] = await tx.update(roles)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)))
          .returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'UPDATE',
          tableName: 'roles',
          recordId: updatedRole.id,
          oldValue: oldRole,
          newValue: updatedRole,
          ipAddress: req.ip,
        }, tx);

        return updatedRole;
      });

      getIoInstance().to(getTenantRoom(tenantId)).emit('role_updated', { roleId: result.id });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const roleId = req.params.id as string;

      await withTenant(tenantId, async (tx) => {
        const [oldRole] = await tx.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));
        
        if (!oldRole) {
          throw new Error('Role not found');
        }

        if (oldRole.name === 'Tenant Admin') {
          throw new Error('Cannot delete the Tenant Admin role');
        }

        // Check if any user is currently assigned this role
        const [assignedUser] = await tx.select().from(users).where(and(eq(users.roleId, roleId), eq(users.tenantId, tenantId))).limit(1);
        if (assignedUser) {
          throw new Error('Cannot delete role because it is currently assigned to users');
        }

        await tx.delete(roles).where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'DELETE',
          tableName: 'roles',
          recordId: roleId,
          oldValue: oldRole,
          ipAddress: req.ip,
        }, tx);
      });

      getIoInstance().to(getTenantRoom(tenantId)).emit('role_deleted', { roleId });

      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}
