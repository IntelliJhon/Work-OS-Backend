import { Router, Response, NextFunction } from 'express';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { users } from '../../db/schema/users';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { requirePlatformAdmin } from '../../middleware/platform-admin.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { SECTIONS, SectionsService, effectiveSections, type Section } from './sections.service';

const handle = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  (async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof ZodError) return res.status(400).json({ error: 'Validation Error', details: err.issues });
      if (err?.status === 404) return res.status(404).json({ error: err.message });
      return next(err);
    }
  }) as any;

const sectionsSchema = z.object({
  sections: z.object(Object.fromEntries(Object.keys(SECTIONS).map((k) => [k, z.boolean().optional()])) as Record<Section, z.ZodOptional<z.ZodBoolean>>).strict(),
});

// ---- /api/workspace: the signed-in person's workspace ----
export const workspaceRouter = Router();
workspaceRouter.use(authenticate as any);

// GET /api/workspace/sections - which sections this workspace has
workspaceRouter.get('/sections', handle(async (req, res) => {
  res.json({ success: true, data: { sections: await SectionsService.forTenant(req.user!.tenantId), labels: SECTIONS } });
}));

// ---- /api/platform/workspaces: platform admins switch sections per workspace ----
export const platformWorkspacesRouter = Router();
platformWorkspacesRouter.use(authenticate as any, requirePlatformAdmin as any);

platformWorkspacesRouter.get('/', handle(async (_req, res) => {
  const rows = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, createdAt: tenants.createdAt, sections: tenants.sections })
    .from(tenants)
    .where(and(eq(tenants.isActive, true), isNull(tenants.deletedAt)))
    .orderBy(asc(tenants.name));
  const data = await Promise.all(rows.map(async (t) => {
    const [members] = await withTenant<{ n: number }[]>(t.id, (tx) =>
      tx.select({ n: count() }).from(users).where(and(eq(users.tenantId, t.id), isNull(users.deletedAt))),
    );
    return { id: t.id, name: t.name, slug: t.slug, createdAt: t.createdAt, members: Number(members?.n ?? 0), sections: effectiveSections(t.sections), switched: t.sections ?? {} };
  }));
  res.json({ success: true, data: { workspaces: data, labels: SECTIONS } });
}));

platformWorkspacesRouter.put('/:tenantId/sections', handle(async (req, res) => {
  const tenantId = z.string().uuid().parse(req.params.tenantId);
  const body = sectionsSchema.parse(req.body);
  const before = await SectionsService.forTenant(tenantId);
  const sections = await SectionsService.update(tenantId, body.sections);
  await AuditService.logAction({
    tenantId, userId: undefined, action: 'UPDATE', tableName: 'tenants', recordId: tenantId,
    oldValue: { sections: before }, newValue: { sections, by: req.user!.id }, ipAddress: req.ip,
  });
  res.json({ success: true, data: { sections } });
}));
