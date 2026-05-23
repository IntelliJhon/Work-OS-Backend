import { Router } from 'express';
import { ProjectsController } from './projects.controller';
import { ProjectMembersController } from './project_members.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createProjectSchema, updateProjectSchema } from './projects.schema';

export const projectsRouter = Router();

projectsRouter.use(authenticate);

projectsRouter.post('/', requirePermissions(['project.create']), validateRequest(createProjectSchema), ProjectsController.create);
projectsRouter.get('/', ProjectsController.list);
projectsRouter.get('/:id', ProjectsController.getById);
projectsRouter.patch('/:id', validateRequest(updateProjectSchema), ProjectsController.update);
projectsRouter.delete('/:id', ProjectsController.delete);

// Project Memberships
projectsRouter.get('/:projectId/members', requirePermissions(['project.read']), ProjectMembersController.list);
projectsRouter.post('/:projectId/members', requirePermissions(['project.manage']), ProjectMembersController.add);
projectsRouter.patch('/:projectId/members/:userId', requirePermissions(['project.manage']), ProjectMembersController.update);
projectsRouter.delete('/:projectId/members/:userId', requirePermissions(['project.manage']), ProjectMembersController.remove);

