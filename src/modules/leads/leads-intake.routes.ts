import { Router, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { LEAD_SOURCES } from '../../db/schema/leads';
import { requireIntegrationSecret } from '../voice-notes/voice-integration.controller';
import { SectionsService } from '../sections/sections.service';
import { LeadsService, LeadError } from './leads.service';
import { logger } from '../../config/logger';
import { maskPhone } from '../../lib/phone';

/**
 * POST /api/integrations/leads — machine-to-machine lead intake for bots and forms (e.g. the WAAU website bot in n8n).
 * Auth: the same X-Integration-Secret header as the other /api/integrations routes (never in the query string).
 * The workspace is chosen by its id (or slug); the Leads section must be switched on for it.
 * Body: { workspace, phone, name?, company?, email?, city?, service?, requirement?, budget?, timeline?, note?, source?, sourceLabel? }
 * Reply: { leadId, created } — calling it again for the same number updates that lead instead of adding another.
 */
export const leadsIntakeRouter = Router();

const opt = (max: number) => z.string().max(max).nullish();
const intakeSchema = z.object({
  workspace: z.string().min(1).max(255),
  phone: z.string().min(6).max(30),
  name: opt(120),
  company: opt(160),
  email: opt(255),
  city: opt(80),
  service: opt(120),
  requirement: opt(2000),
  budget: opt(80),
  timeline: opt(80),
  note: opt(2000),
  source: z.enum(LEAD_SOURCES).optional(),
  sourceLabel: opt(60),
});

leadsIntakeRouter.post('/', requireIntegrationSecret, async (req: Request, res: Response) => {
  try {
    const body = intakeSchema.parse(req.body ?? {});
    // Workspace by its id (preferred: ids never change) or its slug
    const ws = body.workspace.trim();
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ws);
    const [tenant] = await db.select({ id: tenants.id }).from(tenants)
      .where(isId ? eq(tenants.id, ws) : eq(tenants.slug, ws.toLowerCase())).limit(1);
    if (!tenant) return res.status(404).json({ error: 'Workspace not found', code: 'workspace' });
    if (!(await SectionsService.isEnabled(tenant.id, 'leads'))) {
      return res.status(403).json({ error: 'Leads are switched off for this workspace', code: 'section_off' });
    }
    const { workspace: _w, ...input } = body;
    const { lead, created } = await LeadsService.intake(tenant.id, input);
    logger.info({ tenantId: tenant.id, leadId: lead.id, created, to: maskPhone(lead.phone) }, '[Leads] Intake');
    return res.status(created ? 201 : 200).json({ leadId: lead.id, created, name: lead.name, stage: lead.stage });
  } catch (err) {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid lead', code: 'validation', issues: err.issues });
    if (err instanceof LeadError) return res.status(err.status).json({ error: err.message, code: err.code });
    logger.error({ err }, '[Leads] Intake failed');
    return res.status(500).json({ error: 'Could not save the lead', code: 'server' });
  }
});
