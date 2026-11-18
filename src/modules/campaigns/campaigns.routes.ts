import { Router, type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { eq } from 'drizzle-orm';
import { authenticate, type AuthRequest } from '../../middleware/auth.middleware';
import { allows, roleAccess } from '../sections/role-access';
import { requireIntegrationSecret } from '../voice-notes/voice-integration.controller';
import { SectionsService } from '../sections/sections.service';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { CAMPAIGN_PARAMS } from '../../db/schema/campaigns';
import { logger } from '../../config/logger';
import { CampaignError, CampaignsService } from './campaigns.service';

/** /api/campaigns — category campaigns (Leads section). Everyone with leads access can look; Admins change them. */
export const campaignsRouter = Router();
campaignsRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response, admin: boolean) => Promise<unknown>;
const handle = (fn: Handler, adminOnly = false) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const role = await roleAccess(req.user!.tenantId, req.user!.roleId);
    if (!role.admin && !allows(role, 'lead.read') && !allows(role, 'lead.manage')) return res.status(403).json({ error: 'No access to Leads' });
    if (adminOnly && !role.admin) return res.status(403).json({ error: 'Only Admins can change campaigns' });
    await fn(req, res, role.admin);
  } catch (err) {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid data', code: 'validation' });
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
}) as any;
const id = z.string().uuid();

const sequenceSchema = z.object({
  category: z.string().trim().min(1, 'Choose the category').max(80),
  active: z.boolean(),
  repeatEveryDays: z.number().int().min(1).max(365).nullable(),
  steps: z.array(z.object({
    day: z.number().int().min(1).max(365),
    templateName: z.string().trim().min(1).max(120),
    language: z.string().trim().min(2).max(10).optional(),
    params: z.array(z.enum(CAMPAIGN_PARAMS)).max(10).optional(),
  })).min(1, 'Add at least one message').max(20),
});

campaignsRouter.get('/', handle(async (req, res, admin) => {
  res.json({ success: true, data: await CampaignsService.listSequences(req.user!.tenantId), isAdmin: admin });
}));
campaignsRouter.post('/', handle(async (req, res) => {
  res.status(201).json({ success: true, data: await CampaignsService.saveSequence(req.user!.tenantId, req.user!.id, sequenceSchema.parse(req.body)) });
}, true));
campaignsRouter.put('/:id', handle(async (req, res) => {
  res.json({ success: true, data: await CampaignsService.saveSequence(req.user!.tenantId, req.user!.id, { ...sequenceSchema.parse(req.body), id: id.parse(req.params.id) }) });
}, true));
campaignsRouter.delete('/:id', handle(async (req, res) => {
  res.json({ success: true, data: await CampaignsService.deleteSequence(req.user!.tenantId, id.parse(req.params.id)) });
}, true));
campaignsRouter.post('/:id/enrol-existing', handle(async (req, res) => {
  res.json({ success: true, data: await CampaignsService.enrolExisting(req.user!.tenantId, id.parse(req.params.id)) });
}, true));
campaignsRouter.get('/enrolments', handle(async (req, res) => {
  const q = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const sequenceId = q(req.query.sequenceId); const refId = q(req.query.refId);
  if (sequenceId) id.parse(sequenceId);
  if (refId) id.parse(refId);
  res.json({ success: true, data: await CampaignsService.listEnrolments(req.user!.tenantId, { status: q(req.query.status), sequenceId, refId }) });
}));
campaignsRouter.post('/enrolments/:id/:action', handle(async (req, res) => {
  const action = z.enum(['pause', 'resume', 'stop']).parse(req.params.action);
  res.json({ success: true, data: await CampaignsService.setEnrolmentStatus(req.user!.tenantId, id.parse(req.params.id), action) });
}, true));

/**
 * POST /api/integrations/campaign-reply — a contact's reply or button tap, forwarded by the WAAU bot's n8n flow.
 * Header X-Integration-Secret. Body: { workspace, phone, text?, button? }. Reply: { handled, action? }.
 */
export const campaignReplyRouter = Router();
const replySchema = z.object({
  workspace: z.string().min(1).max(255),
  phone: z.string().min(6).max(30),
  text: z.string().max(4000).nullish(),
  button: z.string().max(200).nullish(),
});
campaignReplyRouter.post('/', requireIntegrationSecret, async (req: Request, res: Response) => {
  try {
    const body = replySchema.parse(req.body ?? {});
    const ws = body.workspace.trim();
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ws);
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(isId ? eq(tenants.id, ws) : eq(tenants.slug, ws.toLowerCase())).limit(1);
    if (!tenant) return res.status(404).json({ error: 'Workspace not found', code: 'workspace' });
    if (!(await SectionsService.isEnabled(tenant.id, 'leads'))) return res.json({ handled: false, reason: 'leads_off' });
    return res.json(await CampaignsService.handleReply(tenant.id, { phone: body.phone, text: body.text, button: body.button }));
  } catch (err) {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid reply', code: 'validation' });
    if (err instanceof CampaignError) return res.status(err.status).json({ error: err.message, code: err.code });
    logger.error({ err }, '[Campaigns] Reply failed');
    return res.status(500).json({ error: 'Could not handle the reply', code: 'server' });
  }
});
