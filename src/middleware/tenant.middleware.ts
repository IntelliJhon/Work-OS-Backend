import { Response, NextFunction } from 'express';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { AuthRequest } from './auth.middleware';

export const injectTenant = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user?.tenantId) {
    return res.status(401).json({ error: 'Tenant context missing from user session' });
  }

  try {
    next();
  } catch (error) {
    next(error);
  }
};

// Helper for DB calls
export const withTenant = async <T>(tenantId: string, callback: (tx: any) => Promise<T>) => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    return await callback(tx);
  });
};
