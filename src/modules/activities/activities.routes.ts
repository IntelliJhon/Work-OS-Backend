import { Router } from 'express';
import { ActivitiesController } from './activities.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createActivitySchema } from './activities.schema';

export const activitiesRouter = Router();

activitiesRouter.use(authenticate);

activitiesRouter.post('/', requirePermissions(['project.manage']), validateRequest(createActivitySchema), ActivitiesController.create);
activitiesRouter.get('/project/:projectId', ActivitiesController.listByProject);
activitiesRouter.delete('/:id', requirePermissions(['project.manage']), ActivitiesController.delete);
