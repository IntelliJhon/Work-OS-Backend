import { Router } from 'express';
import { AuditController } from './audit.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';

export const auditRouter = Router();

auditRouter.use(authenticate);

auditRouter.get('/', requirePermissions(['workspace.security.read']), AuditController.list);
