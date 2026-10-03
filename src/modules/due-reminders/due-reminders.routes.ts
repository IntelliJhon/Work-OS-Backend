import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { uploadLimiter } from '../../middleware/rateLimiter';
import { isRealDay } from '../attendance/attendance.service';
import { CATEGORIES, DueRemindersService, ReminderError } from './due-reminders.service';

// Who may see or change a reminder is decided in DueRemindersService (owner, creator, Admins).

const reminderSchema = z.object({
  title: z.string().trim().min(2).max(200),
  notes: z.string().trim().max(2000).nullish(),
  category: z.enum(CATEGORIES),
  amount: z.number().min(0).max(9_999_999_999).nullish(),
  repeat: z.enum(['once', 'monthly', 'yearly', 'custom']),
  everyN: z.number().int().min(1).max(365).nullish(),
  everyUnit: z.enum(['day', 'week', 'month']).nullish(),
  dueDate: z.string().refine(isRealDay, 'Invalid date'),
  ownerId: z.string().uuid().nullish(),
});
const id = z.string().uuid();

// Proof files: photos and PDFs, up to 5 × 10 MB, kept in memory until they are uploaded
const proofUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 } });

export const dueRemindersRouter = Router();
dueRemindersRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err: any) {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Validation Error', details: err.issues });
    if (err instanceof ReminderError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;

// GET /api/reminders?scope=mine|all
dueRemindersRouter.get('/', handle(async (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'mine';
  res.json({ success: true, data: await DueRemindersService.list(req.user!.tenantId, req.user!.id, scope) });
}));

dueRemindersRouter.post('/', handle(async (req, res) => {
  const body = reminderSchema.parse(req.body);
  res.status(201).json({ success: true, data: await DueRemindersService.create(req.user!.tenantId, req.user!.id, body) });
}));

dueRemindersRouter.get('/:id', handle(async (req, res) => {
  res.json({ success: true, data: await DueRemindersService.get(req.user!.tenantId, req.user!.id, id.parse(req.params.id)) });
}));

dueRemindersRouter.put('/:id', handle(async (req, res) => {
  const body = reminderSchema.parse(req.body);
  res.json({ success: true, data: await DueRemindersService.update(req.user!.tenantId, req.user!.id, id.parse(req.params.id), body) });
}));

dueRemindersRouter.post('/:id/cancel', handle(async (req, res) => {
  res.json({ success: true, data: await DueRemindersService.cancel(req.user!.tenantId, req.user!.id, id.parse(req.params.id)) });
}));

// POST /api/reminders/:id/complete (multipart: report + files[])
dueRemindersRouter.post(
  '/:id/complete',
  uploadLimiter as any,
  ((req: AuthRequest, res: Response, next: NextFunction) =>
    proofUpload.array('files', 5)(req as any, res as any, (err: any) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file can be at most 10 MB' : err.code === 'LIMIT_FILE_COUNT' ? 'Attach at most 5 files' : 'The files could not be read';
      return res.status(400).json({ error: message, code: 'proof_files' });
    })) as any,
  handle(async (req, res) => {
    const files = ((req as any).files ?? []) as Express.Multer.File[];
    const report = typeof req.body?.report === 'string' ? req.body.report : '';
    res.json({ success: true, data: await DueRemindersService.complete(req.user!.tenantId, req.user!.id, id.parse(req.params.id), report, files) });
  }),
);

// GET /api/reminders/:id/proofs/:uploadId - a short-lived link to open a proof file
dueRemindersRouter.get('/:id/proofs/:uploadId', handle(async (req, res) => {
  res.json({ success: true, data: await DueRemindersService.proofUrl(req.user!.tenantId, req.user!.id, id.parse(req.params.id), id.parse(req.params.uploadId)) });
}));
