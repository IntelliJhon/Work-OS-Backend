import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { uploadLimiter } from '../../middleware/rateLimiter';
import { allows, roleAccess } from '../sections/role-access';
import { CompanyMailService, MailError } from './company-mail.service';

// Company email: Admins set the mailbox up; anyone who can work on leads (lead.manage, Admins always) sends from it.

const settingsSchema = z.object({
  fromEmail: z.string().trim().email('Enter the company email address'),
  fromName: z.string().trim().max(120).nullish(),
  smtpHost: z.string().trim().min(3, 'Enter the SMTP server').max(255),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  imapHost: z.string().trim().max(255).nullish(),
  imapPort: z.coerce.number().int().min(1).max(65535).default(993),
  username: z.string().trim().min(1, 'Enter the mailbox username').max(255),
  password: z.string().max(500).optional(),
  signature: z.string().max(2000).nullish(),
});
const emailList = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\s]+/) : []).map((x) => String(x).trim()).filter(Boolean);
const sendSchema = z.object({
  to: z.preprocess(emailList, z.array(z.string().email('Check the email addresses')).min(1, 'Add a recipient').max(20)),
  cc: z.preprocess(emailList, z.array(z.string().email('Check the CC addresses')).max(20)).optional(),
  subject: z.string().trim().min(1, 'Add a subject').max(300),
  body: z.string().max(20000),
  leadId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
  uploadIds: z.preprocess((v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []), z.array(z.string().uuid()).max(10)).optional(),
});

const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 5 } });
const readFiles = (req: AuthRequest, res: Response, next: NextFunction) =>
  uploadLimiter(req as any, res as any, () =>
    fileUpload.array('files', 5)(req as any, res as any, (err: any) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file can be at most 15 MB' : err.code === 'LIMIT_FILE_COUNT' ? 'Attach at most 5 files' : 'The files could not be read';
      return res.status(400).json({ error: message, code: 'files' });
    }));

export const companyMailRouter = Router();
companyMailRouter.use(authenticate as any);

type Who = { tenantId: string; userId: string; admin: boolean; canSend: boolean };
const handle = (fn: (req: AuthRequest, res: Response, who: Who) => Promise<unknown>) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const role = await roleAccess(req.user!.tenantId, req.user!.roleId);
    await fn(req, res, { tenantId: req.user!.tenantId, userId: req.user!.id, admin: role.admin, canSend: allows(role, 'lead.manage') });
  } catch (err: any) {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Please check the form', code: 'validation' });
    if (err instanceof MailError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;
const adminOnly = (who: Who) => {
  if (!who.admin) throw new MailError(403, 'forbidden', 'Only Admins can change the company email');
};

companyMailRouter.get('/status', handle(async (_req, res, who) => {
  res.json({ success: true, data: { ...(await CompanyMailService.status(who.tenantId)), canSend: who.canSend, isAdmin: who.admin } });
}));
companyMailRouter.get('/settings', handle(async (_req, res, who) => {
  adminOnly(who);
  res.json({ success: true, data: await CompanyMailService.settings(who.tenantId) });
}));
companyMailRouter.put('/settings', handle(async (req, res, who) => {
  adminOnly(who);
  res.json({ success: true, data: await CompanyMailService.save(who.tenantId, who.userId, settingsSchema.parse(req.body)) });
}));
companyMailRouter.delete('/settings', handle(async (_req, res, who) => {
  adminOnly(who);
  res.json({ success: true, data: await CompanyMailService.remove(who.tenantId) });
}));
companyMailRouter.post('/test', handle(async (_req, res, who) => {
  adminOnly(who);
  res.json({ success: true, data: await CompanyMailService.test(who.tenantId) });
}));
companyMailRouter.post('/send', readFiles as any, handle(async (req, res, who) => {
  if (!who.canSend) throw new MailError(403, 'forbidden', 'Your role cannot send company email');
  const input = sendSchema.parse(req.body);
  const files = (((req as any).files ?? []) as Express.Multer.File[]).map((f) => ({ name: f.originalname, content: f.buffer, contentType: f.mimetype }));
  res.json({ success: true, data: await CompanyMailService.send(who.tenantId, who.userId, { ...input, files, via: 'manual' }) });
}));
companyMailRouter.get('/leads/:leadId', handle(async (req, res, who) => {
  res.json({ success: true, data: await CompanyMailService.forLead(who.tenantId, z.string().uuid().parse(req.params.leadId)) });
}));
