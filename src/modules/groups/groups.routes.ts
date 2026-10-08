import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { uploadLimiter } from '../../middleware/rateLimiter';
import { GroupError, GroupsService } from './groups.service';
import { GroupSummaryService } from './group-summary.service';
import { isRealDay } from '../attendance/attendance.service';

// Who may do what is decided in GroupsService (members only; group admins and workspace Admins manage).

const id = z.string().uuid();
const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullish(),
  memberIds: z.array(z.string().uuid()).max(500).default([]),
});
const updateSchema = z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(500).nullish() });
const membersSchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(500) });
const roleSchema = z.object({ role: z.enum(['admin', 'member']) });
const day = z.string().refine(isRealDay, 'Invalid date');
const summarySchema = z.object({ from: day, to: day, refresh: z.boolean().optional() });
const taskSchema = z.object({
  messageId: z.string().uuid().nullish(),
  name: z.string().trim().min(2).max(255),
  assigneeId: z.string().uuid(),
  dueDate: day.nullish(),
});

// Shared files: up to 5 × 10 MB per message, kept in memory until uploaded
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 } });

export const groupsRouter = Router();
groupsRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err: any) {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Validation Error', details: err.issues });
    if (err instanceof GroupError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;
const who = (req: AuthRequest) => ({ tenantId: req.user!.tenantId, userId: req.user!.id });

groupsRouter.get('/', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.list(who(req).tenantId, who(req).userId) });
}));
groupsRouter.get('/unread', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.unreadTotal(who(req).tenantId, who(req).userId) });
}));
groupsRouter.get('/people', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.directory(who(req).tenantId) });
}));
groupsRouter.post('/', handle(async (req, res) => {
  res.status(201).json({ success: true, data: await GroupsService.create(who(req).tenantId, who(req).userId, createSchema.parse(req.body)) });
}));
groupsRouter.get('/:id', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.get(who(req).tenantId, who(req).userId, id.parse(req.params.id)) });
}));
groupsRouter.patch('/:id', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.update(who(req).tenantId, who(req).userId, id.parse(req.params.id), updateSchema.parse(req.body)) });
}));
groupsRouter.delete('/:id', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.archive(who(req).tenantId, who(req).userId, id.parse(req.params.id)) });
}));
groupsRouter.post('/:id/members', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.addMembers(who(req).tenantId, who(req).userId, id.parse(req.params.id), membersSchema.parse(req.body).userIds) });
}));
groupsRouter.delete('/:id/members/:userId', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.removeMember(who(req).tenantId, who(req).userId, id.parse(req.params.id), id.parse(req.params.userId)) });
}));
groupsRouter.put('/:id/members/:userId/role', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.setRole(who(req).tenantId, who(req).userId, id.parse(req.params.id), id.parse(req.params.userId), roleSchema.parse(req.body).role) });
}));

// Messages
groupsRouter.get('/:id/messages', handle(async (req, res) => {
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : undefined;
  res.json({ success: true, data: await GroupsService.messages(who(req).tenantId, who(req).userId, id.parse(req.params.id), before) });
}));

// POST /api/groups/:id/messages - JSON { body, mentions } or multipart (body, mentions as JSON text, files[])
const readFiles = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.is('multipart/form-data')) return next();
  return uploadLimiter(req as any, res as any, () =>
    fileUpload.array('files', 5)(req as any, res as any, (err: any) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file can be at most 10 MB'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Share at most 5 files at a time' : 'The files could not be read';
      return res.status(400).json({ error: message, code: 'files' });
    }));
};
groupsRouter.post('/:id/messages', readFiles as any, handle(async (req, res) => {
  let mentions: unknown = req.body?.mentions;
  if (typeof mentions === 'string') {
    try {
      mentions = JSON.parse(mentions);
    } catch {
      mentions = [];
    }
  }
  const body = typeof req.body?.body === 'string' ? req.body.body : '';
  const parsedMentions = z.array(z.string().uuid()).max(100).catch([]).parse(mentions ?? []);
  const files = ((req as any).files ?? []) as Express.Multer.File[];
  const replyToId = typeof req.body?.replyToId === 'string' && req.body.replyToId ? id.parse(req.body.replyToId) : null;
  // Set for a voice message recorded in the chat: its length in milliseconds
  const voiceDurationMs = req.body?.voiceDurationMs != null && req.body.voiceDurationMs !== '' ? Number(req.body.voiceDurationMs) : null;
  res.status(201).json({ success: true, data: await GroupsService.send(who(req).tenantId, who(req).userId, id.parse(req.params.id), { body, mentions: parsedMentions, files, replyToId, voiceDurationMs }) });
}));
groupsRouter.delete('/:id/messages/:messageId', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.deleteMessage(who(req).tenantId, who(req).userId, id.parse(req.params.id), id.parse(req.params.messageId)) });
}));
groupsRouter.post('/:id/read', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.markRead(who(req).tenantId, who(req).userId, id.parse(req.params.id)) });
}));
groupsRouter.get('/:id/files/:uploadId', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.fileUrl(who(req).tenantId, who(req).userId, id.parse(req.params.id), id.parse(req.params.uploadId)) });
}));

// Pinned messages (group admins pin)
groupsRouter.get('/:id/pinned', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.pinned(who(req).tenantId, who(req).userId, id.parse(req.params.id)) });
}));
groupsRouter.post('/:id/messages/:messageId/pin', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.setPinned(who(req).tenantId, who(req).userId, id.parse(req.params.id), id.parse(req.params.messageId), true) });
}));
groupsRouter.delete('/:id/messages/:messageId/pin', handle(async (req, res) => {
  res.json({ success: true, data: await GroupsService.setPinned(who(req).tenantId, who(req).userId, id.parse(req.params.id), id.parse(req.params.messageId), false) });
}));

// GET /api/groups/:id/search?q=words
groupsRouter.get('/:id/search', handle(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  res.json({ success: true, data: await GroupsService.search(who(req).tenantId, who(req).userId, id.parse(req.params.id), q) });
}));

// POST /api/groups/:id/tasks - a task from a message or a summary's action item
groupsRouter.post('/:id/tasks', handle(async (req, res) => {
  const body = taskSchema.parse(req.body);
  res.status(201).json({ success: true, data: await GroupsService.createTask(who(req).tenantId, who(req).userId, req.user!.roleId, id.parse(req.params.id), body) });
}));

// POST /api/groups/:id/summary { from, to, refresh } - AI summary of those days (saved; reused until new messages)
groupsRouter.post('/:id/summary', handle(async (req, res) => {
  const body = summarySchema.parse(req.body);
  res.json({ success: true, data: await GroupSummaryService.summarize(who(req).tenantId, who(req).userId, id.parse(req.params.id), body.from, body.to, body.refresh === true) });
}));
