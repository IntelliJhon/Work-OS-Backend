import { Router } from 'express';
import { EpicsController } from './epics.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createEpicSchema, updateEpicSchema } from './epics.schema';

export const epicsRouter = Router();

epicsRouter.use(authenticate);

epicsRouter.post('/', validateRequest(createEpicSchema), EpicsController.create);
epicsRouter.get('/', EpicsController.list);
epicsRouter.patch('/:id', validateRequest(updateEpicSchema), EpicsController.update);
epicsRouter.delete('/:id', EpicsController.delete);
