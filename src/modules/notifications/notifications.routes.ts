import { Router } from 'express';
import { NotificationsController } from './notifications.controller';
import { authenticate } from '../../middleware/auth.middleware';

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get('/', NotificationsController.list);
notificationsRouter.get('/unread-count', NotificationsController.getUnreadCount);
notificationsRouter.patch('/read-all', NotificationsController.markAllRead);
notificationsRouter.patch('/:id/read', NotificationsController.markRead);
