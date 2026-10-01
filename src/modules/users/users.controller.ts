import { Response, NextFunction } from 'express';
import { users } from '../../db/schema/users';
import { roles } from '../../db/schema/roles';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { eq, and, or, ilike, sql, isNull, ne } from 'drizzle-orm';
import { refreshTokens } from '../../db/schema/auth';
import { leaveRequests } from '../../db/schema/leave';
import { db } from '../../db';
import bcrypt from 'bcrypt';
import { getIoInstance } from '../../socket/socketServer';
import { getTenantRoom } from '../../socket/tenantRooms';
import { normalizePhone } from '../../lib/phone';

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
      const perms = req.user!.permissions || {};
      const canSeePhones = req.user!.role === 'Admin' || perms['admin'] === true || perms['workspace.members.read'] === true;

      const result = await withTenant(tenantId, async (tx) => {
        let conditions = and(eq(users.tenantId, tenantId), isNull(users.deletedAt)) as any;

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
            phone: users.phone,
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
          // Every member can list users (assignee pickers), but phone numbers are only for member managers
          users: canSeePhones ? tenantUsers : tenantUsers.map(({ phone, ...rest }: any) => rest),
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

      const changes = { ...req.body };
      if ('phone' in changes) {
        // Stored in the same normalized form used to send WhatsApp messages; empty clears it
        const raw = changes.phone;
        changes.phone = raw === null || String(raw).trim() === '' ? null : normalizePhone(raw);
        if (raw && !changes.phone) {
          return res.status(400).json({ error: 'Enter a valid WhatsApp number with country code' });
        }
      }

      const result = await withTenant(tenantId, async (tx) => {
        const [oldUser] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));

        if (!oldUser) {
          throw new Error('User not found');
        }

        const [updatedUser] = await tx.update(users)
          .set({ ...changes, updatedAt: new Date() })
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

      if (userId === req.user!.id) {
        return res.status(400).json({ error: 'You cannot remove yourself from the workspace' });
      }

      // A member can't be erased: their work, comments and the security log keep pointing to them. Removing
      // deactivates them instead: hidden everywhere, signed out, and their email and number are free again.
      const now = new Date();
      const found = await withTenant(tenantId, async (tx) => {
        const [oldUser] = await tx
          .select()
          .from(users)
          .where(and(eq(users.id, userId), eq(users.tenantId, tenantId), isNull(users.deletedAt)));
        if (!oldUser) return null;

        await tx
          .update(users)
          .set({ deletedAt: now, updatedAt: now, phone: null, reportsTo: null, email: `removed-${now.getTime()}+${oldUser.email}`.slice(0, 255) })
          .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
        // Nobody reports to them any more
        await tx
          .update(users)
          .set({ reportsTo: null })
          .where(and(eq(users.tenantId, tenantId), eq(users.reportsTo, userId), ne(users.id, userId)));

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
        return oldUser;
      });
      if (!found) return res.status(404).json({ error: 'This member was not found (they may already be removed)' });

      // Sign them out everywhere and withdraw leave that is still waiting for a decision
      await withTenant(tenantId, (tx) =>
        tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))),
      );
      await db
        .update(leaveRequests)
        .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.userId, userId), sql`${leaveRequests.status} in ('pending_manager', 'pending_admin')`));

      try {
        getIoInstance().to(getTenantRoom(tenantId)).emit('member_deleted', { userId });
      } catch {
        // Live update only; the removal is done
      }

      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}
