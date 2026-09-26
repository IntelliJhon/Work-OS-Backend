import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { AuthRequest } from './auth.middleware';
import { withTenant } from './tenant.middleware';
import { users } from '../db/schema/users';
import { env } from '../config/env';

const adminEmails = () =>
  env.PLATFORM_ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Whether the signed-in user is a platform admin (email listed in PLATFORM_ADMIN_EMAILS). */
export async function isPlatformAdmin(req: AuthRequest): Promise<boolean> {
  const allowed = adminEmails();
  if (!req.user || allowed.length === 0) return false;
  // The access token carries no email; users has row-level security, so read it in the tenant context
  const [user] = await withTenant<{ email: string }[]>(req.user.tenantId, (tx) =>
    tx.select({ email: users.email }).from(users).where(eq(users.id, req.user!.id)).limit(1),
  );
  return !!user && allowed.includes(user.email.toLowerCase());
}

/** Platform-wide administration (all workspaces). Use after authenticate. */
export const requirePlatformAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (await isPlatformAdmin(req)) return next();
    return res.status(403).json({ error: 'Platform admin access required' });
  } catch (err) {
    return next(err);
  }
};
