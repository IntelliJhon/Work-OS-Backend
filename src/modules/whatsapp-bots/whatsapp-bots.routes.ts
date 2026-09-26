import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { requirePlatformAdmin, isPlatformAdmin } from '../../middleware/platform-admin.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { WhatsAppBotsService, WhatsAppBotError } from './whatsapp-bots.service';
import { AuditService } from '../../services/audit.service';

const templateName = z.string().trim().regex(/^[a-z0-9_]{1,100}$/, 'Template names use lowercase letters, digits and _').nullish().or(z.literal(''));

const upsertBotSchema = z.object({
  params: z.object({ tenantId: z.string().uuid() }),
  body: z.object({
    phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'Phone number ID must be digits'),
    // Optional on update: omit to keep the stored token
    accessToken: z.string().trim().min(20).max(1000).nullish().or(z.literal('')),
    businessPhone: z.string().trim().max(25).nullish(),
    otpTemplate: templateName,
    ownerTemplate: templateName,
    employeeTemplate: templateName,
    templateLang: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'Language like en or en_US').nullish().or(z.literal('')),
  }),
});

const tenantParamSchema = z.object({ params: z.object({ tenantId: z.string().uuid() }) });

const handle = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof WhatsAppBotError) return res.status(err.status).json({ error: err.message, code: err.code });
      return next(err);
    }
  };

// ---- /api/platform ----
export const platformRouter = Router();
platformRouter.use(authenticate as any);

// Anyone signed in may ask (the frontend uses it to show or hide the platform admin screen)
platformRouter.get('/me', handle(async (req, res) => {
  res.json({ isPlatformAdmin: await isPlatformAdmin(req) });
}) as any);

platformRouter.get('/whatsapp-bots', requirePlatformAdmin as any, handle(async (_req, res) => {
  res.json({ success: true, ...(await WhatsAppBotsService.listForAdmin()) });
}) as any);

platformRouter.put('/whatsapp-bots/:tenantId', requirePlatformAdmin as any, validateRequest(upsertBotSchema), handle(async (req, res) => {
  const tenantId = req.params.tenantId as string;
  await WhatsAppBotsService.upsert(tenantId, req.user!.id, req.body);
  // Never log the token itself
  await AuditService.logAction({
    tenantId,
    userId: req.user!.id,
    action: 'UPDATE',
    tableName: 'tenant_whatsapp_bots',
    recordId: tenantId,
    newValue: { phoneNumberId: req.body.phoneNumberId, tokenChanged: !!req.body.accessToken },
    ipAddress: req.ip,
  }).catch(() => undefined);
  res.json({ success: true });
}) as any);

platformRouter.delete('/whatsapp-bots/:tenantId', requirePlatformAdmin as any, validateRequest(tenantParamSchema), handle(async (req, res) => {
  const tenantId = req.params.tenantId as string;
  await WhatsAppBotsService.remove(tenantId);
  await AuditService.logAction({
    tenantId,
    userId: req.user!.id,
    action: 'DELETE',
    tableName: 'tenant_whatsapp_bots',
    recordId: tenantId,
    ipAddress: req.ip,
  }).catch(() => undefined);
  res.json({ success: true });
}) as any);
