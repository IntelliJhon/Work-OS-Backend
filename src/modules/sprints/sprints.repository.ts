import { sprints } from '../../db/schema/sprints';
import { tasks } from '../../db/schema/tasks';
import { activities } from '../../db/schema/activities';
import { eq, and, inArray } from 'drizzle-orm';

export class SprintsRepository {
  static async getSprintById(tx: any, tenantId: string, sprintId: string) {
    const [sprint] = await tx.select().from(sprints).where(and(eq(sprints.id, sprintId), eq(sprints.tenantId, tenantId)));
    return sprint;
  }

  static async getActivityById(tx: any, tenantId: string, activityId: string) {
    const [activity] = await tx.select().from(activities).where(and(eq(activities.id, activityId), eq(activities.tenantId, tenantId)));
    return activity;
  }

  static async getActiveSprintsInActivity(tx: any, tenantId: string, activityId: string) {
    return await tx.select().from(sprints).where(and(
      eq(sprints.activityId, activityId),
      eq(sprints.tenantId, tenantId),
      eq(sprints.status, 'active')
    ));
  }

  static async getActiveSprintsInPhase(tx: any, tenantId: string, phaseId: string) {
    const phaseActivities = await tx.select().from(activities).where(and(
      eq(activities.phaseId, phaseId),
      eq(activities.tenantId, tenantId)
    ));
    if (phaseActivities.length === 0) return [];
    
    const activityIds = phaseActivities.map((a: any) => a.id);
    return await tx.select().from(sprints).where(and(
      inArray(sprints.activityId, activityIds),
      eq(sprints.tenantId, tenantId),
      eq(sprints.status, 'active')
    ));
  }

  static async getIncompleteTasksForSprint(tx: any, tenantId: string, sprintId: string) {
    const allTasks = await tx.select().from(tasks).where(and(
      eq(tasks.sprintId, sprintId),
      eq(tasks.tenantId, tenantId)
    ));
    return allTasks.filter((t: any) => t.status !== 'done' && t.status !== 'completed');
  }

  static async updateSprintStatus(tx: any, tenantId: string, sprintId: string, status: 'planning' | 'active' | 'closed' | 'cancelled') {
    const [updatedSprint] = await tx.update(sprints)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(sprints.id, sprintId), eq(sprints.tenantId, tenantId)))
      .returning();
    return updatedSprint;
  }

  static async createSprint(tx: any, tenantId: string, data: any) {
    const [sprint] = await tx.insert(sprints).values({
      tenantId,
      ...data,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
    }).returning();
    return sprint;
  }

  static async getSprintsByActivityId(tx: any, tenantId: string, activityId: string) {
    return await tx.select().from(sprints).where(and(eq(sprints.activityId, activityId), eq(sprints.tenantId, tenantId)));
  }

  static async getSprintsByProjectId(tx: any, tenantId: string, projectId: string) {
    return await tx.select().from(sprints).where(and(eq(sprints.projectId, projectId), eq(sprints.tenantId, tenantId)));
  }
}
