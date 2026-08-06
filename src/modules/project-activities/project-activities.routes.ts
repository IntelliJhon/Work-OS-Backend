import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { ProjectActivitiesController } from './project-activities.controller';
import { createProjectActivitySchema, updateProjectActivitySchema } from './project-activities.schema';

const router = Router();

router.use(authenticate);

router.post('/', validateRequest(createProjectActivitySchema), ProjectActivitiesController.create);
router.get('/project/:projectId', ProjectActivitiesController.listByProject);
router.put('/:id', validateRequest(updateProjectActivitySchema), ProjectActivitiesController.update);
router.delete('/:id', ProjectActivitiesController.delete);

export default router;
