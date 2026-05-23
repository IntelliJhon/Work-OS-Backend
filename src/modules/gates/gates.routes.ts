import { Router } from 'express';
import { GatesController } from './gates.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';

export const gatesRouter = Router();

gatesRouter.use(authenticate);

gatesRouter.post('/:id/approve', requirePermissions(['project.manage']), GatesController.approve);
gatesRouter.post('/:id/reject', requirePermissions(['project.manage']), GatesController.reject);
gatesRouter.post('/:id/resubmit', requirePermissions(['project.manage']), GatesController.resubmit);
gatesRouter.get('/project/:projectId', GatesController.listByProject);
