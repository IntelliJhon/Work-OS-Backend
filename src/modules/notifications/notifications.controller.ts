import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { NotificationsService } from './notifications.service';

export class NotificationsController {
  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
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
      const tenantId = req.user!.tenantId;
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
      const tenantId = req.user!.tenantId;
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
      const tenantId = req.user!.tenantId;
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
