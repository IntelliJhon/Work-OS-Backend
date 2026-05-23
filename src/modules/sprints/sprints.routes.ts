import { Router } from 'express';
import { SprintsController } from './sprints.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';

export const sprintsRouter = Router();

sprintsRouter.use(authenticate);

sprintsRouter.post('/', requirePermissions(['project.manage']), SprintsController.create);
sprintsRouter.get('/project/:projectId', SprintsController.listByProject);
sprintsRouter.post('/:id/start', requirePermissions(['project.manage']), SprintsController.start);
sprintsRouter.post('/:id/close', requirePermissions(['project.manage']), SprintsController.close);
sprintsRouter.post('/:id/cancel', requirePermissions(['project.manage']), SprintsController.cancel);
sprintsRouter.post('/:id/reopen', requirePermissions(['project.manage']), SprintsController.reopen);
