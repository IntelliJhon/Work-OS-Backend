import { Router, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { roleAccess } from '../sections/role-access';
import { McpKeyError, McpKeysService, MCP_SECTIONS } from './mcp-keys.service';
import { TOOL_LIST } from './mcp-server';

// Admins manage the workspace's MCP access keys (Settings → AI & MCP)

const createSchema = z.object({ name: z.string().trim().min(2).max(80), sections: z.array(z.string()).min(1).max(20) });

export const mcpKeysRouter = Router();
mcpKeysRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const adminOnly = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const access = await roleAccess(req.user!.tenantId, req.user!.roleId);
    if (!access.admin) return res.status(403).json({ error: 'Only Admins can manage MCP access keys', code: 'forbidden' });
    await fn(req, res);
  } catch (err: any) {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Please check the form', code: 'validation' });
    if (err instanceof McpKeyError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;

mcpKeysRouter.get('/', adminOnly(async (req, res) => {
  res.json({ success: true, data: await McpKeysService.list(req.user!.tenantId), sections: MCP_SECTIONS, tools: TOOL_LIST });
}));
mcpKeysRouter.post('/', adminOnly(async (req, res) => {
  res.status(201).json({ success: true, data: await McpKeysService.create(req.user!.tenantId, req.user!.id, createSchema.parse(req.body)) });
}));
mcpKeysRouter.delete('/:id', adminOnly(async (req, res) => {
  res.json({ success: true, data: await McpKeysService.revoke(req.user!.tenantId, z.string().uuid().parse(req.params.id)) });
}));
