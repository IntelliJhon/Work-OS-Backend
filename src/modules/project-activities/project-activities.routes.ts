import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { ProjectActivitiesController } from './project-activities.controller';
import { createProjectActivitySchema } from './project-activities.schema';

const router = Router();

router.use(authenticate);

router.post('/', validateRequest(createProjectActivitySchema), ProjectActivitiesController.create);
router.get('/project/:projectId', ProjectActivitiesController.listByProject);
router.delete('/:id', ProjectActivitiesController.delete);

export default router;
