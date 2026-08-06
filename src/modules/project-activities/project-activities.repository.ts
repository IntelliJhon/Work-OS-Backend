import { eq, and, desc } from 'drizzle-orm';
import { projectActivities } from '../../db/schema/project_activities';

export class ProjectActivitiesRepository {
  static async create(tx: any, tenantId: string, data: { projectId: string; parentId?: string | null; title: string; workHrs: number }) {
    const [item] = await tx
      .insert(projectActivities)
      .values({
        tenantId,
        projectId: data.projectId,
        parentId: data.parentId || null,
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
      .orderBy(projectActivities.createdAt);
  }

  static async update(tx: any, tenantId: string, id: string, data: { title?: string; workHrs?: number }) {
    const updateData: any = { updatedAt: new Date() };
    if (data.title !== undefined) updateData.title = data.title;
    if (data.workHrs !== undefined) updateData.workHrs = String(data.workHrs);

    const [updated] = await tx
      .update(projectActivities)
      .set(updateData)
      .where(and(
        eq(projectActivities.tenantId, tenantId),
        eq(projectActivities.id, id)
      ))
      .returning();
    return updated;
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
