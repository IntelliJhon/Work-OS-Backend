import { notifications } from '../../db/schema/notifications';
import { eq, and, desc, sql } from 'drizzle-orm';
import { NotificationInput } from './notifications.types';

export class NotificationsRepository {
  static async createNotification(tx: any, input: NotificationInput) {
    // Prevent duplicate notifications within 1 minute
    const oneMinuteAgo = new Date(Date.now() - 60000);
    const existing = await tx.select().from(notifications)
      .where(and(
        eq(notifications.tenantId, input.tenantId),
        eq(notifications.recipientUserId, input.recipientUserId),
        eq(notifications.type, input.type),
        input.entityType ? eq(notifications.entityType, input.entityType) : sql`1=1`,
        input.entityId ? eq(notifications.entityId, input.entityId) : sql`1=1`,
        sql`${notifications.createdAt} > ${oneMinuteAgo}`
      ))
      .limit(1);

    if (existing.length > 0) {
      return null; // Silent skip for duplicates
    }

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
    const result = await tx.select({ count: sql`count(*)` }).from(notifications)
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
