import { Router } from 'express';
import { StoriesController } from './stories.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { createStorySchema, updateStorySchema } from './stories.schema';

export const storiesRouter = Router();

storiesRouter.use(authenticate);

storiesRouter.post('/', validateRequest(createStorySchema), StoriesController.create);
storiesRouter.get('/', StoriesController.list);
storiesRouter.patch('/:id', validateRequest(updateStorySchema), StoriesController.update);
storiesRouter.delete('/:id', StoriesController.delete);
