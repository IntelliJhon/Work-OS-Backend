import { Router } from 'express';
import { PhasesController } from './phases.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';

export const phasesRouter = Router();

phasesRouter.use(authenticate);

// We require project.manage for phase transitions
phasesRouter.post('/:id/activate', requirePermissions(['project.manage']), PhasesController.activate);
phasesRouter.post('/:id/complete', requirePermissions(['project.manage']), PhasesController.complete);
phasesRouter.post('/:id/block', requirePermissions(['project.manage']), PhasesController.block);
phasesRouter.post('/:id/reopen', requirePermissions(['project.manage']), PhasesController.reopen);
