import { Router } from 'express';
import { InvitationsController } from './invitations.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createInviteSchema, acceptInviteSchema } from './invitations.schema';

export const invitationsRouter = Router();

// Public routes (no auth required)
invitationsRouter.get('/verify/:token', InvitationsController.verify);
invitationsRouter.post('/accept', validateRequest(acceptInviteSchema), InvitationsController.accept);

// Protected routes (require auth)
invitationsRouter.use(authenticate);

invitationsRouter.get('/', requirePermissions(['workspace.members.read']), InvitationsController.list);
invitationsRouter.post('/', requirePermissions(['workspace.members.invite']), validateRequest(createInviteSchema), InvitationsController.create);
invitationsRouter.post('/:id/resend', requirePermissions(['workspace.members.invite']), InvitationsController.resend);
invitationsRouter.post('/:id/revoke', requirePermissions(['workspace.members.invite']), InvitationsController.revoke);
