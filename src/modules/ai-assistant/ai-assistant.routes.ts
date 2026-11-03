import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { uploadLimiter } from '../../middleware/rateLimiter';
import { AiAssistantService, AiError, type Asker } from './ai-assistant.service';

// The in-app AI assistant. Everyone can chat; what the AI can do follows the person's own role permissions.

const id = z.string().uuid();
const messageSchema = z.object({ conversationId: z.string().uuid().optional(), text: z.string().max(8000).default('') });

// Up to 5 files × 15 MB per message, kept in memory until uploaded
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 5 } });
const readFiles = (req: AuthRequest, res: Response, next: NextFunction) =>
  uploadLimiter(req as any, res as any, () =>
    fileUpload.array('files', 5)(req as any, res as any, (err: any) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file can be at most 15 MB'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Share at most 5 files at a time' : 'The files could not be read';
      return res.status(400).json({ error: message, code: 'files' });
    }));

export const aiAssistantRouter = Router();
aiAssistantRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response, asker: Asker) => Promise<unknown>;
const handle = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res, { tenantId: req.user!.tenantId, userId: req.user!.id, roleId: req.user!.roleId });
  } catch (err: any) {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Please check the message', code: 'validation' });
    if (err instanceof AiError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;

aiAssistantRouter.get('/status', handle(async (_req, res) => {
  res.json({ success: true, data: { available: AiAssistantService.available() } });
}));
aiAssistantRouter.get('/conversations', handle(async (_req, res, asker) => {
  res.json({ success: true, data: await AiAssistantService.conversations(asker) });
}));
aiAssistantRouter.get('/conversations/:id', handle(async (req, res, asker) => {
  res.json({ success: true, data: await AiAssistantService.view(asker, id.parse(req.params.id)) });
}));
aiAssistantRouter.delete('/conversations/:id', handle(async (req, res, asker) => {
  res.json({ success: true, data: await AiAssistantService.remove(asker, id.parse(req.params.id)) });
}));
aiAssistantRouter.post('/messages', readFiles as any, handle(async (req, res, asker) => {
  const input = messageSchema.parse(req.body);
  const files = ((req as any).files ?? []) as Express.Multer.File[];
  res.json({ success: true, data: await AiAssistantService.send(asker, { ...input, files }) });
}));
aiAssistantRouter.post('/actions/:id/confirm', handle(async (req, res, asker) => {
  res.json({ success: true, data: await AiAssistantService.confirm(asker, id.parse(req.params.id)) });
}));
aiAssistantRouter.post('/actions/:id/cancel', handle(async (req, res, asker) => {
  res.json({ success: true, data: await AiAssistantService.cancel(asker, id.parse(req.params.id)) });
}));
