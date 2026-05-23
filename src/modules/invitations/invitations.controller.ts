import { Request, Response, NextFunction } from 'express';
import { db } from '../../db';
import { invitations } from '../../db/schema/invitations';
import { users } from '../../db/schema/users';
import { roles } from '../../db/schema/roles';
import { tenants } from '../../db/schema/tenants';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { AuthService } from '../auth/auth.service';
import { eq, and, isNull, gt } from 'drizzle-orm';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

export class InvitationsController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { email, roleId } = req.body;

      const result = await withTenant(tenantId, async (tx) => {
        // 1. Check if user is already a member
        const [existingUser] = await tx
          .select()
          .from(users)
          .where(and(eq(users.email, email), eq(users.tenantId, tenantId)));

        if (existingUser) {
          throw new Error('User with this email is already a member of this workspace');
        }

        // 2. Check if active invitation already exists to prevent duplicate invites
        const now = new Date();
        const [existingInvite] = await tx
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.email, email),
              eq(invitations.tenantId, tenantId),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              gt(invitations.expiresAt, now)
            )
          );

        if (existingInvite) {
          throw new Error('An active invitation is already pending for this email');
        }

        // 3. Create invitation
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 Hours expiration

        const [newInvite] = await tx
          .insert(invitations)
          .values({
            tenantId,
            email,
            roleId,
            token,
            expiresAt,
          })
          .returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'INSERT',
          tableName: 'invitations',
          recordId: newInvite.id,
          newValue: newInvite,
          ipAddress: req.ip,
        }, tx);

        return newInvite;
      });

      return res.status(201).json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error.message || 'Failed to create invitation' });
    }
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        return await tx
          .select({
            id: invitations.id,
            email: invitations.email,
            roleId: invitations.roleId,
            roleName: roles.name,
            expiresAt: invitations.expiresAt,
            acceptedAt: invitations.acceptedAt,
            revokedAt: invitations.revokedAt,
            createdAt: invitations.createdAt,
          })
          .from(invitations)
          .innerJoin(roles, eq(invitations.roleId, roles.id))
          .where(eq(invitations.tenantId, tenantId));
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async resend(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const inviteId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        const [oldInvite] = await tx
          .select()
          .from(invitations)
          .where(and(eq(invitations.id, inviteId), eq(invitations.tenantId, tenantId)));

        if (!oldInvite) {
          throw new Error('Invitation not found');
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

        const [updatedInvite] = await tx
          .update(invitations)
          .set({
            token,
            expiresAt,
            revokedAt: null,
            acceptedAt: null,
          })
          .where(and(eq(invitations.id, inviteId), eq(invitations.tenantId, tenantId)))
          .returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'UPDATE',
          tableName: 'invitations',
          recordId: updatedInvite.id,
          oldValue: oldInvite,
          newValue: updatedInvite,
          ipAddress: req.ip,
        }, tx);

        return updatedInvite;
      });

      return res.json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }

  static async revoke(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const inviteId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        const [oldInvite] = await tx
          .select()
          .from(invitations)
          .where(and(eq(invitations.id, inviteId), eq(invitations.tenantId, tenantId)));

        if (!oldInvite) {
          throw new Error('Invitation not found');
        }

        const [updatedInvite] = await tx
          .update(invitations)
          .set({
            revokedAt: new Date(),
          })
          .where(and(eq(invitations.id, inviteId), eq(invitations.tenantId, tenantId)))
          .returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'UPDATE',
          tableName: 'invitations',
          recordId: updatedInvite.id,
          oldValue: oldInvite,
          newValue: updatedInvite,
          ipAddress: req.ip,
        }, tx);

        return updatedInvite;
      });

      return res.json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }

  static async verify(req: Request, res: Response, next: NextFunction) {
    try {
      const token = req.params.token as string;

      const [invite] = await db
        .select()
        .from(invitations)
        .where(eq(invitations.token, token));

      if (!invite) {
        return res.status(404).json({ error: 'Invalid invitation link' });
      }

      const details = await withTenant(invite.tenantId, async (tx) => {
        const [role] = await tx
          .select({ name: roles.name })
          .from(roles)
          .where(eq(roles.id, invite.roleId));

        const [tenant] = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, invite.tenantId));

        return {
          roleName: role?.name || 'Member',
          tenantName: tenant?.name || 'Workspace',
        };
      });

      const responseInvite = {
        id: invite.id,
        email: invite.email,
        roleId: invite.roleId,
        roleName: details.roleName,
        tenantId: invite.tenantId,
        tenantName: details.tenantName,
        expiresAt: invite.expiresAt,
        acceptedAt: invite.acceptedAt,
        revokedAt: invite.revokedAt,
      };

      const now = new Date();
      if (responseInvite.acceptedAt) {
        return res.status(400).json({ error: 'This invitation has already been accepted' });
      }
      if (responseInvite.revokedAt) {
        return res.status(400).json({ error: 'This invitation has been revoked' });
      }
      if (responseInvite.expiresAt < now) {
        return res.status(400).json({ error: 'This invitation has expired' });
      }

      return res.json(responseInvite);
    } catch (error) {
      next(error);
    }
  }

  static async accept(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, password, firstName, lastName } = req.body;

      // Find invite
      const [invite] = await db
        .select()
        .from(invitations)
        .where(eq(invitations.token, token as string));

      if (!invite) {
        return res.status(404).json({ error: 'Invalid invitation link' });
      }

      const now = new Date();
      if (invite.acceptedAt) {
        return res.status(400).json({ error: 'This invitation has already been accepted' });
      }
      if (invite.revokedAt) {
        return res.status(400).json({ error: 'This invitation has been revoked' });
      }
      if (invite.expiresAt < now) {
        return res.status(400).json({ error: 'This invitation has expired' });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      // Perform user creation and invite acceptance inside transaction scoped to the tenant
      const result = await withTenant(invite.tenantId, async (tx) => {
        // Confirm user email unique within this tenant
        const [existingUser] = await tx
          .select()
          .from(users)
          .where(and(eq(users.email, invite.email), eq(users.tenantId, invite.tenantId)));

        if (existingUser) {
          throw new Error('User already exists in this workspace');
        }

        // Create new user
        const [newUser] = await tx
          .insert(users)
          .values({
            tenantId: invite.tenantId,
            email: invite.email,
            passwordHash,
            firstName,
            lastName,
            roleId: invite.roleId,
          })
          .returning();

        // Update invitation as accepted
        await tx
          .update(invitations)
          .set({ acceptedAt: new Date() })
          .where(eq(invitations.id, invite.id));

        const role = await tx.select().from(roles).where(eq(roles.id, invite.roleId)).limit(1);

        // Access and Refresh Tokens
        const accessToken = AuthService.generateAccessToken(newUser, role[0]);
        const refreshToken = await AuthService.generateRefreshToken(tx, newUser);

        // Audit Logging
        const { passwordHash: _, ...safeUser } = newUser;
        await AuditService.logAction({
          tenantId: invite.tenantId,
          userId: newUser.id,
          action: 'INSERT',
          tableName: 'users',
          recordId: newUser.id,
          newValue: safeUser,
          ipAddress: req.ip,
        }, tx);

        await AuditService.logAction({
          tenantId: invite.tenantId,
          userId: newUser.id,
          action: 'UPDATE',
          tableName: 'invitations',
          recordId: invite.id,
          newValue: { acceptedAt: new Date() },
          ipAddress: req.ip,
        }, tx);

        return {
          accessToken,
          refreshToken,
          user: {
            id: newUser.id,
            email: newUser.email,
            firstName: newUser.firstName,
            lastName: newUser.lastName,
            tenantId: newUser.tenantId,
            role: role[0].name,
            permissions: role[0].permissions,
          },
        };
      });

      return res.status(200).json(result);
    } catch (error: any) {
      return res.status(400).json({ error: error.message || 'Invitation acceptance failed' });
    }
  }
}
