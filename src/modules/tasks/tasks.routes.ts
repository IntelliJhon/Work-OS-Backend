import { Router } from 'express';
import { TasksController } from './tasks.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { injectTenant } from '../../middleware/tenant.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createTaskSchema } from './tasks.schema';

const router = Router();

// Apply auth and tenant middlewares to all routes
router.use(authenticate);
router.use(injectTenant);

router.post('/', requirePermissions(['task.create']), validateRequest(createTaskSchema), TasksController.create);
router.get('/', requirePermissions(['task.read']), TasksController.list);

// Let standard assignees hit these routes; fine-grained ownership checks are performed in the controllers
router.patch('/:id', requirePermissions(['task.read']), TasksController.update);
router.delete('/:id', requirePermissions(['task.read']), TasksController.delete);

export const tasksRouter = router;
