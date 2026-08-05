import { eq, and, desc } from 'drizzle-orm';
import { projectActivities } from '../../db/schema/project_activities';

export class ProjectActivitiesRepository {
  static async create(tx: any, tenantId: string, data: { projectId: string; title: string; workHrs: number }) {
    const [item] = await tx
      .insert(projectActivities)
      .values({
        tenantId,
        projectId: data.projectId,
        title: data.title,
        workHrs: String(data.workHrs || 0),
      })
      .returning();
    return item;
  }

  static async listByProject(tx: any, tenantId: string, projectId: string) {
    return await tx
      .select()
      .from(projectActivities)
      .where(and(
        eq(projectActivities.tenantId, tenantId),
        eq(projectActivities.projectId, projectId)
      ))
      .orderBy(desc(projectActivities.createdAt));
  }

  static async delete(tx: any, tenantId: string, id: string) {
    const [deleted] = await tx
      .delete(projectActivities)
      .where(and(
        eq(projectActivities.tenantId, tenantId),
        eq(projectActivities.id, id)
      ))
      .returning();
    return deleted;
  }
}
