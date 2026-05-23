const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, 'src', 'modules', 'notifications');
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

const typesContent = `export interface NotificationInput {
  tenantId: string;
  recipientUserId: string;
  actorUserId?: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  metadata?: any;
}
`;

const schemaContent = `import { z } from 'zod';

export const readNotificationSchema = z.object({
  body: z.object({}).strict().optional(), // No body needed for reading, but good for validation structure
});
`;

const repoContent = `import { notifications } from '../../db/schema/notifications';
import { eq, and, desc, sql } from 'drizzle-orm';
import { NotificationInput } from './notifications.types';

export class NotificationsRepository {
  static async createNotification(tx: any, input: NotificationInput) {
    const [notification] = await tx.insert(notifications).values(input).returning();
    return notification;
  }

  static async listUserNotifications(tx: any, tenantId: string, userId: string, limit: number = 50, offset: number = 0) {
    return await tx.select().from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.recipientUserId, userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);
  }

  static async getUnreadCount(tx: any, tenantId: string, userId: string) {
    const result = await tx.select({ count: sql\`count(*)\` }).from(notifications)
      .where(and(
        eq(notifications.tenantId, tenantId), 
        eq(notifications.recipientUserId, userId), 
        eq(notifications.isRead, false)
      ));
    return Number(result[0]?.count || 0);
  }

  static async markAsRead(tx: any, tenantId: string, userId: string, notificationId: string) {
    const [updated] = await tx.update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(and(
        eq(notifications.id, notificationId),
        eq(notifications.tenantId, tenantId),
        eq(notifications.recipientUserId, userId)
      )).returning();
    return updated;
  }

  static async markAllAsRead(tx: any, tenantId: string, userId: string) {
    const result = await tx.update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.recipientUserId, userId),
        eq(notifications.isRead, false)
      )).returning();
    return result;
  }
}
`;

const serviceContent = `import { NotificationsRepository } from './notifications.repository';
import { NotificationInput } from './notifications.types';
import { emitWorkflowEvent } from '../../socket/eventEmitter';
import { logger } from '../../config/logger';
import { db } from '../../db';

export class NotificationsService {
  /**
   * Safe entry point to create a notification and emit a socket event.
   * Can be called after a transaction commits.
   */
  static async notify(input: NotificationInput) {
    try {
      // Create locally in its own small transaction or directly
      const notification = await NotificationsRepository.createNotification(db, input);

      // Emit safely to the specific recipient's room
      // Since it is to a specific user, we still use emitWorkflowEvent 
      // but we may want a dedicated notify method. For now, the existing emitWorkflowEvent 
      // broadcasts to tenant:{tenantId}. Let's just create a new socket utility for users.
      
      const { getIoInstance } = require('../../socket/socketServer');
      const { getUserRoom } = require('../../socket/tenantRooms');
      const io = getIoInstance();
      io.to(getUserRoom(input.recipientUserId)).emit('NOTIFICATION_CREATED', notification);

      logger.debug({ type: input.type, recipient: input.recipientUserId }, 'Notification created and emitted');
      return notification;
    } catch (error) {
      logger.error({ error, input }, 'Failed to create notification');
      // Do not throw to prevent crashing the main business flow
    }
  }

  static async listNotifications(tx: any, tenantId: string, userId: string, limit?: number, offset?: number) {
    return await NotificationsRepository.listUserNotifications(tx, tenantId, userId, limit, offset);
  }

  static async getUnreadCount(tx: any, tenantId: string, userId: string) {
    return await NotificationsRepository.getUnreadCount(tx, tenantId, userId);
  }

  static async markAsRead(tx: any, tenantId: string, userId: string, notificationId: string) {
    return await NotificationsRepository.markAsRead(tx, tenantId, userId, notificationId);
  }

  static async markAllAsRead(tx: any, tenantId: string, userId: string) {
    return await NotificationsRepository.markAllAsRead(tx, tenantId, userId);
  }
}
`;

const controllerContent = `import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { NotificationsService } from './notifications.service';

export class NotificationsController {
  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const userId = req.user!.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await withTenant(tenantId, async (tx) => {
        return await NotificationsService.listNotifications(tx, tenantId, userId, limit, offset);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async getUnreadCount(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const userId = req.user!.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await NotificationsService.getUnreadCount(tx, tenantId, userId);
      });

      return res.json({ count: result });
    } catch (error) {
      next(error);
    }
  }

  static async markRead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const userId = req.user!.id;
      const notificationId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await NotificationsService.markAsRead(tx, tenantId, userId, notificationId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async markAllRead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const userId = req.user!.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await NotificationsService.markAllAsRead(tx, tenantId, userId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
`;

const routesContent = `import { Router } from 'express';
import { NotificationsController } from './notifications.controller';
import { authenticate } from '../../middleware/auth.middleware';

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get('/', NotificationsController.list);
notificationsRouter.get('/unread-count', NotificationsController.getUnreadCount);
notificationsRouter.patch('/read-all', NotificationsController.markAllRead);
notificationsRouter.patch('/:id/read', NotificationsController.markRead);
`;

fs.writeFileSync(path.join(baseDir, 'notifications.types.ts'), typesContent);
fs.writeFileSync(path.join(baseDir, 'notifications.schema.ts'), schemaContent);
fs.writeFileSync(path.join(baseDir, 'notifications.repository.ts'), repoContent);
fs.writeFileSync(path.join(baseDir, 'notifications.service.ts'), serviceContent);
fs.writeFileSync(path.join(baseDir, 'notifications.controller.ts'), controllerContent);
fs.writeFileSync(path.join(baseDir, 'notifications.routes.ts'), routesContent);

console.log("Notifications generated.");
