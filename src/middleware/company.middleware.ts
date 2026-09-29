import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';

/**
 * The company's own workspace (LeadsNDeals). Clients and Complaints are internal tools of this
 * workspace only. Matched on the tenant id alone: names and slugs are chosen at signup, so anyone
 * could register a workspace called "leadsndeals-…".
 */
export const LEADSNDEALS_TENANT_ID = 'aee1faf8-27d5-4f5d-9b14-9246abbd0eec';

export const isLeadsndealsTenant = (tenantId: string | undefined | null) => tenantId === LEADSNDEALS_TENANT_ID;

/** Only the LeadsNDeals workspace. Use after authenticate. */
export const requireLeadsndeals = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (isLeadsndealsTenant(req.user?.tenantId)) return next();
  return res.status(403).json({ error: 'This feature is not available for your workspace', code: 'feature_unavailable' });
};
