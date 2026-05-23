import { Router } from 'express';
import { UsersController } from './users.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createUserSchema, updateUserSchema } from './users.schema';

export const usersRouter = Router();

usersRouter.use(authenticate);

usersRouter.post('/', requirePermissions(['workspace.members.invite']), validateRequest(createUserSchema), UsersController.create);
usersRouter.get('/', UsersController.list);
usersRouter.patch('/:id', requirePermissions(['workspace.members.update']), validateRequest(updateUserSchema), UsersController.update);
usersRouter.delete('/:id', requirePermissions(['workspace.members.remove']), UsersController.delete);
