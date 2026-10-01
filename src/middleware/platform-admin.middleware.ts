import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { AuthRequest } from './auth.middleware';
import { db } from '../db';
import { platformAdmins } from '../db/schema/platform_admins';

/**
 * Whether the signed-in account is a platform admin (listed in platform_admins by user id). The id comes from the
 * signed access token; matching on email instead would let anyone register a workspace with an admin's address.
 */
export async function isPlatformAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  const [row] = await db.select({ userId: platformAdmins.userId }).from(platformAdmins).where(eq(platformAdmins.userId, req.user.id)).limit(1);
  return !!row;
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
