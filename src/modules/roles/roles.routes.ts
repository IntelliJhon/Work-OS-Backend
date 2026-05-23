import { Router } from 'express';
import { RolesController } from './roles.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createRoleSchema, updateRoleSchema } from './roles.schema';

export const rolesRouter = Router();

rolesRouter.use(authenticate);

rolesRouter.post('/', requirePermissions(['workspace.members.update']), validateRequest(createRoleSchema), RolesController.create);
rolesRouter.get('/', RolesController.list);
rolesRouter.patch('/:id', requirePermissions(['workspace.members.update']), validateRequest(updateRoleSchema), RolesController.update);
rolesRouter.delete('/:id', requirePermissions(['workspace.members.update']), RolesController.delete);
