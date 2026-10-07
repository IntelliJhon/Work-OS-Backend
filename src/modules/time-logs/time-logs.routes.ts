import { Router, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { isRealDay } from '../attendance/attendance.service';
import { TimeLogError, TimeLogsService } from './time-logs.service';

// Time worked on project tasks (who may do what is decided in TimeLogsService)

const id = z.string().uuid();
const day = z.string().refine(isRealDay, 'Choose a valid date');
const minutes = z.number().int('Use whole minutes').min(1, 'Enter how long you worked').max(24 * 60, 'At most 24 hours');
const note = z.string().trim().min(1, 'Write what you did').max(2000);
const createSchema = z.object({ taskId: id, workDate: day, minutes, note });
const updateSchema = z.object({ workDate: day, minutes, note }).partial();
const dailySchema = z.object({ userId: id.optional(), from: day, to: day });

export const timeLogsRouter = Router();
timeLogsRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err: any) {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Please check the form', code: 'validation' });
    if (err instanceof TimeLogError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;
const t = (req: AuthRequest) => req.user!.tenantId;
const me = (req: AuthRequest) => req.user!.id;

// GET /api/time-logs/task/:taskId - entries and totals of one work item
timeLogsRouter.get('/task/:taskId', handle(async (req, res) => {
  res.json({ success: true, data: await TimeLogsService.forTask(t(req), me(req), id.parse(req.params.taskId)) });
}));
// GET /api/time-logs/daily?from&to[&userId] - hours per day (own; Admins and PMs: anyone, or everyone without userId)
timeLogsRouter.get('/daily', handle(async (req, res) => {
  res.json({ success: true, data: await TimeLogsService.daily(t(req), me(req), dailySchema.parse(req.query)) });
}));
timeLogsRouter.post('/', handle(async (req, res) => {
  res.status(201).json({ success: true, data: await TimeLogsService.create(t(req), me(req), createSchema.parse(req.body)) });
}));
timeLogsRouter.patch('/:id', handle(async (req, res) => {
  res.json({ success: true, data: await TimeLogsService.update(t(req), me(req), id.parse(req.params.id), updateSchema.parse(req.body)) });
}));
timeLogsRouter.delete('/:id', handle(async (req, res) => {
  res.json({ success: true, data: await TimeLogsService.remove(t(req), me(req), id.parse(req.params.id)) });
}));
