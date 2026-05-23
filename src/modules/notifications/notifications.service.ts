import { NotificationsRepository } from './notifications.repository';
import { NotificationInput } from './notifications.types';
import { emitWorkflowEvent } from '../../socket/eventEmitter';
import { logger } from '../../config/logger';
import { db } from '../../db';

export class NotificationsService {
  /**
   * Safe entry point to create a notification and emit a socket event.
   * Can be called after a transaction commits, or pass tx to run within RLS.
   */
  static async notify(input: NotificationInput, tx: any = db) {
    try {
      const notification = await NotificationsRepository.createNotification(tx, input);

      if (!notification) {
        logger.debug({ type: input.type, recipient: input.recipientUserId }, 'Duplicate notification prevented');
        return null;
      }

      const { getIoInstance } = require('../../socket/socketServer');
      const { getUserRoom } = require('../../socket/tenantRooms');
      const io = getIoInstance();
      if (io) {
        io.to(getUserRoom(input.tenantId, input.recipientUserId)).emit('NOTIFICATION_CREATED', notification);
      }

      logger.debug({ type: input.type, recipient: input.recipientUserId }, 'Notification created and emitted');
      return notification;
    } catch (error) {
      logger.error({ error, input }, 'Failed to create notification');
    }
  }

  static async listNotifications(tx: any, tenantId: string, userId: string, limit?: number, offset?: number) {
    return await NotificationsRepository.listUserNotifications(tx, tenantId, userId, limit, offset);
  }

  static async getUnreadCount(tx: any, tenantId: string, userId: string) {
    return await NotificationsRepository.getUnreadCount(tx, tenantId, userId);
  }

  private static async syncUnreadCount(tx: any, tenantId: string, userId: string) {
    try {
      const count = await NotificationsRepository.getUnreadCount(tx, tenantId, userId);
      const { getIoInstance } = require('../../socket/socketServer');
      const { getUserRoom } = require('../../socket/tenantRooms');
      const io = getIoInstance();
      io.to(getUserRoom(tenantId, userId)).emit('UNREAD_COUNT_UPDATED', { count });
    } catch (error) {
      logger.error({ error, tenantId, userId }, 'Failed to sync unread count');
    }
  }

  static async markAsRead(tx: any, tenantId: string, userId: string, notificationId: string) {
    const result = await NotificationsRepository.markAsRead(tx, tenantId, userId, notificationId);
    await this.syncUnreadCount(tx, tenantId, userId);
    return result;
  }

  static async markAllAsRead(tx: any, tenantId: string, userId: string) {
    const result = await NotificationsRepository.markAllAsRead(tx, tenantId, userId);
    await this.syncUnreadCount(tx, tenantId, userId);
    return result;
  }
}
