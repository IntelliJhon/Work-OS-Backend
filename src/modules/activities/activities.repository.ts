import { activities } from '../../db/schema/activities';
import { eq, and } from 'drizzle-orm';

export class ActivitiesRepository {
  static async getActivityById(tx: any, tenantId: string, activityId: string) {
    const [activity] = await tx.select().from(activities).where(and(eq(activities.id, activityId), eq(activities.tenantId, tenantId)));
    return activity;
  }

  static async createActivity(tx: any, tenantId: string, data: any) {
    const [activity] = await tx.insert(activities).values({
      tenantId,
      ...data,
    }).returning();
    return activity;
  }

  static async getActivitiesByProjectId(tx: any, tenantId: string, projectId: string) {
    return await tx.select().from(activities).where(and(eq(activities.projectId, projectId), eq(activities.tenantId, tenantId)));
  }

  static async deleteActivity(tx: any, tenantId: string, activityId: string) {
    const [deleted] = await tx.delete(activities)
      .where(and(eq(activities.id, activityId), eq(activities.tenantId, tenantId)))
      .returning();
    return deleted;
  }
}
