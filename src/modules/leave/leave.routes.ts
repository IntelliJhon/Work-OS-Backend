import { Router, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { isRealDay, localParts } from '../attendance/attendance.service';
import { LeaveError, LeaveService } from './leave.service';

// Who may do what is decided in LeaveService from the person's role in the database (not the token).

const day = z.string().refine(isRealDay, 'Invalid date');
const applySchema = z.object({
  from: day,
  to: day,
  halfDay: z.enum(['first', 'second']).nullish(),
  reason: z.string().trim().min(2).max(500),
});
const decideSchema = z.object({ comment: z.string().trim().max(500).nullish() });
const reportsToSchema = z.object({ reportsTo: z.string().uuid().nullable() });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const id = z.string().uuid();

export const leaveRouter = Router();
leaveRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Validation Error', details: err.issues });
    if (err instanceof LeaveError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;

// GET /api/leave/mine - my requests
leaveRouter.get('/mine', handle(async (req, res) => {
  res.json({ success: true, data: await LeaveService.mine(req.user!.tenantId, req.user!.id) });
}));

// POST /api/leave - apply
leaveRouter.post('/', handle(async (req, res) => {
  const body = applySchema.parse(req.body);
  res.status(201).json({ success: true, data: await LeaveService.apply(req.user!.tenantId, req.user!.id, body) });
}));

// GET /api/leave/inbox - requests I can approve or reject now (with clash warnings)
leaveRouter.get('/inbox', handle(async (req, res) => {
  res.json({ success: true, data: await LeaveService.inbox(req.user!.tenantId, req.user!.id) });
}));

// GET /api/leave/all?month=YYYY-MM - everyone's requests (Admins, Project Managers)
leaveRouter.get('/all', handle(async (req, res) => {
  const m = month.parse(req.query.month ?? localParts(new Date()).day.slice(0, 7));
  res.json({ success: true, data: await LeaveService.all(req.user!.tenantId, req.user!.id, m) });
}));

// Reports to (Admins)
leaveRouter.get('/team', handle(async (req, res) => {
  res.json({ success: true, data: await LeaveService.team(req.user!.tenantId, req.user!.id) });
}));
leaveRouter.put('/team/:userId', handle(async (req, res) => {
  const body = reportsToSchema.parse(req.body);
  res.json({ success: true, data: await LeaveService.setReportsTo(req.user!.tenantId, req.user!.id, id.parse(req.params.userId), body.reportsTo) });
}));

// POST /api/leave/:id/approve | reject | cancel
leaveRouter.post('/:id/approve', handle(async (req, res) => {
  const body = decideSchema.parse(req.body ?? {});
  res.json({ success: true, data: await LeaveService.decide(req.user!.tenantId, req.user!.id, id.parse(req.params.id), 'approve', body.comment) });
}));
leaveRouter.post('/:id/reject', handle(async (req, res) => {
  const body = decideSchema.parse(req.body ?? {});
  res.json({ success: true, data: await LeaveService.decide(req.user!.tenantId, req.user!.id, id.parse(req.params.id), 'reject', body.comment) });
}));
leaveRouter.post('/:id/cancel', handle(async (req, res) => {
  res.json({ success: true, data: await LeaveService.cancel(req.user!.tenantId, req.user!.id, id.parse(req.params.id)) });
}));
