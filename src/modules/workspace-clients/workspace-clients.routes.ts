import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { uploadLimiter } from '../../middleware/rateLimiter';
import { allows, roleAccess } from '../sections/role-access';
import { isRealDay } from '../attendance/attendance.service';
import { ClientError, WorkspaceClientsService, type Access } from './workspace-clients.service';

// The Clients section of every workspace (LeadsNDeals' own CRM-linked clients stay at /api/clients).
// Who may do what is decided in WorkspaceClientsService from the role's current permissions.

const id = z.string().uuid();
const opt = (max: number) => z.string().trim().max(max).nullish();
const fields = {
  name: z.string().trim().min(2, 'Enter the client name').max(160),
  contactPerson: opt(120),
  phone: z.string().trim().min(6, 'Enter the WhatsApp number').max(25),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address').max(255)]).nullish(),
  city: opt(80),
  address: opt(500),
  gstNumber: opt(20),
  category: opt(60),
  status: z.enum(['active', 'on_hold', 'former']),
  accountManagerId: z.union([z.literal(''), z.string().uuid()]).nullish(),
  clientSince: z.union([z.literal(''), z.string().refine(isRealDay, 'Invalid date')]).nullish(),
  notes: opt(2000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
};
const createSchema = z.object({ ...fields, status: fields.status.default('active'), tags: fields.tags.default([]) });
const updateSchema = z.object(fields).partial();
const noteSchema = z.object({ body: z.string().trim().min(1, 'Write the note first').max(4000) });

// Documents: up to 10 × 15 MB at a time, kept in memory until uploaded
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
const readFiles = (req: AuthRequest, res: Response, next: NextFunction) =>
  uploadLimiter(req as any, res as any, () =>
    fileUpload.array('files', 10)(req as any, res as any, (err: any) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file can be at most 15 MB'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Add at most 10 files at a time' : 'The files could not be read';
      return res.status(400).json({ error: message, code: 'files' });
    }));

export const workspaceClientsRouter = Router();
workspaceClientsRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response, access: Access) => Promise<unknown>;
const handle = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const role = await roleAccess(req.user!.tenantId, req.user!.roleId);
    const access: Access = {
      userId: req.user!.id,
      admin: role.admin,
      read: allows(role, 'client.read') || allows(role, 'client.manage'),
      manage: allows(role, 'client.manage'),
    };
    await fn(req, res, access);
  } catch (err: any) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? 'Please check the form', code: 'validation', details: err.issues });
    }
    if (err instanceof ClientError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;
const tenant = (req: AuthRequest) => req.user!.tenantId;
const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 100) : undefined);

workspaceClientsRouter.get('/', handle(async (req, res, access) => {
  const filter = { q: str(req.query.q), status: str(req.query.status), category: str(req.query.category), managerId: str(req.query.managerId) };
  if (filter.managerId) id.parse(filter.managerId);
  res.json({ success: true, data: await WorkspaceClientsService.list(tenant(req), access, filter), canManage: access.manage, isAdmin: access.admin });
}));
workspaceClientsRouter.get('/categories', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.categories(tenant(req), access) });
}));
workspaceClientsRouter.get('/people', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.people(tenant(req), access) });
}));
workspaceClientsRouter.post('/', handle(async (req, res, access) => {
  res.status(201).json({ success: true, data: await WorkspaceClientsService.create(tenant(req), access, createSchema.parse(req.body)) });
}));
workspaceClientsRouter.get('/:id', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.get(tenant(req), access, id.parse(req.params.id)), canManage: access.manage, isAdmin: access.admin });
}));
workspaceClientsRouter.patch('/:id', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.update(tenant(req), access, id.parse(req.params.id), updateSchema.parse(req.body)) });
}));
workspaceClientsRouter.delete('/:id', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.archive(tenant(req), access, id.parse(req.params.id)) });
}));
workspaceClientsRouter.post('/:id/restore', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.restore(tenant(req), access, id.parse(req.params.id)) });
}));

// The client's projects
workspaceClientsRouter.get('/:id/projects', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.projects(tenant(req), access, id.parse(req.params.id)) });
}));

// Notes and the change history
workspaceClientsRouter.get('/:id/activity', handle(async (req, res, access) => {
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : undefined;
  res.json({ success: true, data: await WorkspaceClientsService.activity(tenant(req), access, id.parse(req.params.id), before) });
}));
workspaceClientsRouter.post('/:id/notes', handle(async (req, res, access) => {
  res.status(201).json({ success: true, data: await WorkspaceClientsService.addNote(tenant(req), access, id.parse(req.params.id), noteSchema.parse(req.body).body) });
}));
workspaceClientsRouter.delete('/:id/notes/:noteId', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.deleteNote(tenant(req), access, id.parse(req.params.id), id.parse(req.params.noteId)) });
}));

// Documents
workspaceClientsRouter.get('/:id/documents', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.documents(tenant(req), access, id.parse(req.params.id)) });
}));
workspaceClientsRouter.post('/:id/documents', readFiles as any, handle(async (req, res, access) => {
  const files = ((req as any).files ?? []) as Express.Multer.File[];
  res.status(201).json({ success: true, data: await WorkspaceClientsService.addDocuments(tenant(req), access, id.parse(req.params.id), files) });
}));
workspaceClientsRouter.get('/:id/documents/:docId', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.documentUrl(tenant(req), access, id.parse(req.params.id), id.parse(req.params.docId)) });
}));
workspaceClientsRouter.delete('/:id/documents/:docId', handle(async (req, res, access) => {
  res.json({ success: true, data: await WorkspaceClientsService.deleteDocument(tenant(req), access, id.parse(req.params.id), id.parse(req.params.docId)) });
}));
