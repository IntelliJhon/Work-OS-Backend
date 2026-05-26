import { Router } from 'express';
import { SprintsController } from './sprints.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createSprintSchema } from './sprints.schema';

export const sprintsRouter = Router();

sprintsRouter.use(authenticate);

sprintsRouter.post('/', requirePermissions(['project.manage']), validateRequest(createSprintSchema), SprintsController.create);
sprintsRouter.get('/activity/:activityId', SprintsController.listByActivity);
sprintsRouter.get('/project/:projectId', SprintsController.listByProject);
sprintsRouter.post('/:id/start', requirePermissions(['project.manage']), SprintsController.start);
sprintsRouter.post('/:id/close', requirePermissions(['project.manage']), SprintsController.close);
sprintsRouter.post('/:id/cancel', requirePermissions(['project.manage']), SprintsController.cancel);
sprintsRouter.post('/:id/reopen', requirePermissions(['project.manage']), SprintsController.reopen);
