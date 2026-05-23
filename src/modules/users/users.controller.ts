import { Response, NextFunction } from 'express';
import { users } from '../../db/schema/users';
import { roles } from '../../db/schema/roles';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { eq, and, or, ilike, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { getIoInstance } from '../../socket/socketServer';
import { getTenantRoom } from '../../socket/tenantRooms';

export class UsersController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { password, ...userData } = req.body;

      const passwordHash = await bcrypt.hash(password, 10);

      const result = await withTenant(tenantId, async (tx) => {
        const [newUser] = await tx.insert(users).values({
          tenantId,
          passwordHash,
          ...userData,
        }).returning();

        // Omit password hash from response
        const { passwordHash: _, ...safeUser } = newUser;

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'INSERT',
          tableName: 'users',
          recordId: newUser.id,
          newValue: safeUser,
          ipAddress: req.ip,
        }, tx);

        return safeUser;
      });

      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = (page - 1) * limit;
      const search = (req.query.search as string) || '';
      const roleId = req.query.roleId as string;

      const result = await withTenant(tenantId, async (tx) => {
        let conditions = eq(users.tenantId, tenantId);

        if (search) {
          conditions = and(
            conditions,
            or(
              ilike(users.firstName, `%${search}%`),
              ilike(users.lastName, `%${search}%`),
              ilike(users.email, `%${search}%`)
            )
          ) as any;
        }

        if (roleId) {
          conditions = and(conditions, eq(users.roleId, roleId)) as any;
        }

        const tenantUsers = await tx
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            roleId: users.roleId,
            roleName: roles.name,
            twoFaEnabled: users.twoFaEnabled,
            createdAt: users.createdAt,
          })
          .from(users)
          .innerJoin(roles, eq(users.roleId, roles.id))
          .where(conditions)
          .limit(limit)
          .offset(offset);

        const [totalCountObj] = await tx
          .select({ count: sql`count(*)` })
          .from(users)
          .where(conditions);

        const total = parseInt(totalCountObj?.count as string || '0');

        return {
          users: tenantUsers,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
          }
        };
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const userId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        const [oldUser] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
        
        if (!oldUser) {
          throw new Error('User not found');
        }

        const [updatedUser] = await tx.update(users)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
          .returning();

        const { passwordHash: oldHash, ...safeOldUser } = oldUser;
        const { passwordHash: newHash, ...safeNewUser } = updatedUser;

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'UPDATE',
          tableName: 'users',
          recordId: updatedUser.id,
          oldValue: safeOldUser,
          newValue: safeNewUser,
          ipAddress: req.ip,
        }, tx);

        return safeNewUser;
      });

      getIoInstance().to(getTenantRoom(tenantId)).emit('member_updated', { userId: result.id });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const userId = req.params.id as string;

      await withTenant(tenantId, async (tx) => {
        const [oldUser] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
        
        if (!oldUser) {
          throw new Error('User not found');
        }

        await tx.delete(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));

        const { passwordHash: _, ...safeOldUser } = oldUser;

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'DELETE',
          tableName: 'users',
          recordId: userId,
          oldValue: safeOldUser,
          ipAddress: req.ip,
        }, tx);
      });

      getIoInstance().to(getTenantRoom(tenantId)).emit('member_deleted', { userId });

      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}
