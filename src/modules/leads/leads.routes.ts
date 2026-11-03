import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { uploadLimiter } from '../../middleware/rateLimiter';
import { allows, roleAccess } from '../sections/role-access';
import { LEAD_SOURCES, LEAD_STAGES, REJECT_REASONS } from '../../db/schema/leads';
import { LeadError, LeadsService, type Access } from './leads.service';

// Leads: enquiries moved through stages on a board. Who may do what is decided in LeadsService from the role's
// current permissions (lead.read, lead.manage; Admins always).

const id = z.string().uuid();
const opt = (max: number) => z.string().trim().max(max).nullish();
const when = z.union([z.literal(''), z.string().datetime({ offset: true, message: 'Invalid date and time' })]).nullish();
const amount = z.union([z.literal('').transform(() => null), z.coerce.number().min(0, 'The amount cannot be negative').max(9_999_999_999)]).nullish();
const fields = {
  name: z.string().trim().min(2, 'Enter the lead\'s name').max(120),
  company: opt(160),
  phone: z.string().trim().min(6, 'Enter the WhatsApp number').max(25),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address').max(255)]).nullish(),
  city: opt(80),
  source: z.enum(LEAD_SOURCES),
  service: opt(120),
  expectedValue: amount,
  ownerId: z.union([z.literal(''), z.string().uuid()]).nullish(),
  nextFollowUpAt: when,
  autoFollowUp: z.boolean(),
  notes: opt(2000),
  requirement: opt(4000),
  budget: opt(80),
  timeline: opt(80),
};
const createSchema = z.object({ ...fields, source: fields.source.default('manual'), autoFollowUp: fields.autoFollowUp.optional(), allowDuplicate: z.boolean().optional() });
const updateSchema = z.object(fields).partial();
const stageSchema = z.object({
  stage: z.enum(LEAD_STAGES),
  requirement: opt(4000),
  budget: opt(80),
  timeline: opt(80),
  rejectReason: z.enum(REJECT_REASONS).optional(),
  rejectNote: opt(1000),
  nextFollowUpAt: when,
  autoFollowUp: z.boolean().optional(),
  sendWhatsApp: z.boolean().optional(),
  acceptAs: z.enum(['bot', 'client']).optional(),
});
const noteSchema = z.object({ body: z.string().trim().min(1, 'Write the note first').max(4000) });
const proposalSchema = z.object({ amount, note: opt(1000) });

// One proposal file at a time, up to 15 MB, kept in memory until uploaded
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const readFile = (req: AuthRequest, res: Response, next: NextFunction) =>
  uploadLimiter(req as any, res as any, () =>
    fileUpload.single('file')(req as any, res as any, (err: any) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'The file can be at most 15 MB' : 'The file could not be read';
      return res.status(400).json({ error: message, code: 'file' });
    }));

export const leadsRouter = Router();
leadsRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response, access: Access) => Promise<unknown>;
const handle = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const role = await roleAccess(req.user!.tenantId, req.user!.roleId);
    const access: Access = {
      userId: req.user!.id,
      admin: role.admin,
      read: allows(role, 'lead.read') || allows(role, 'lead.manage'),
      manage: allows(role, 'lead.manage'),
    };
    await fn(req, res, access);
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? 'Please check the form', code: 'validation', details: err.issues });
    }
    if (err instanceof LeadError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.data ? { data: err.data } : {}) });
    return next(err);
  }
}) as any;
const tenant = (req: AuthRequest) => req.user!.tenantId;
const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 100) : undefined);

leadsRouter.get('/', handle(async (req, res, access) => {
  const filter = { q: str(req.query.q), ownerId: str(req.query.ownerId), source: str(req.query.source), archived: req.query.archived === 'true' };
  if (filter.ownerId && filter.ownerId !== 'none') id.parse(filter.ownerId);
  res.json({ success: true, data: await LeadsService.list(tenant(req), access, filter), canManage: access.manage, isAdmin: access.admin });
}));
leadsRouter.get('/people', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.people(tenant(req), access) });
}));
leadsRouter.post('/', handle(async (req, res, access) => {
  const { allowDuplicate, ...input } = createSchema.parse(req.body);
  res.status(201).json({ success: true, data: await LeadsService.create(tenant(req), access, input as any, allowDuplicate) });
}));
leadsRouter.get('/:id', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.get(tenant(req), access, id.parse(req.params.id)), canManage: access.manage, isAdmin: access.admin });
}));
leadsRouter.patch('/:id', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.update(tenant(req), access, id.parse(req.params.id), updateSchema.parse(req.body) as any) });
}));
leadsRouter.post('/:id/stage', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.moveStage(tenant(req), access, id.parse(req.params.id), stageSchema.parse(req.body) as any) });
}));
leadsRouter.delete('/:id', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.archive(tenant(req), access, id.parse(req.params.id)) });
}));
leadsRouter.post('/:id/restore', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.restore(tenant(req), access, id.parse(req.params.id)) });
}));

// Notes and the change history
leadsRouter.get('/:id/activity', handle(async (req, res, access) => {
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : undefined;
  res.json({ success: true, data: await LeadsService.activity(tenant(req), access, id.parse(req.params.id), before) });
}));
leadsRouter.post('/:id/notes', handle(async (req, res, access) => {
  res.status(201).json({ success: true, data: await LeadsService.addNote(tenant(req), access, id.parse(req.params.id), noteSchema.parse(req.body).body) });
}));
leadsRouter.delete('/:id/notes/:noteId', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.deleteNote(tenant(req), access, id.parse(req.params.id), id.parse(req.params.noteId)) });
}));

// Proposals
leadsRouter.get('/:id/proposals', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.proposals(tenant(req), access, id.parse(req.params.id)) });
}));
leadsRouter.post('/:id/proposals', readFile as any, handle(async (req, res, access) => {
  const input = proposalSchema.parse(req.body);
  res.status(201).json({ success: true, data: await LeadsService.addProposal(tenant(req), access, id.parse(req.params.id), { amount: input.amount ?? null, note: input.note ?? null }, (req as any).file) });
}));
leadsRouter.post('/:id/proposals/:proposalId/whatsapp', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.sendProposal(tenant(req), access, id.parse(req.params.id), id.parse(req.params.proposalId)) });
}));
leadsRouter.get('/:id/proposals/:proposalId/file', handle(async (req, res, access) => {
  res.json({ success: true, data: await LeadsService.proposalUrl(tenant(req), access, id.parse(req.params.id), id.parse(req.params.proposalId)) });
}));
