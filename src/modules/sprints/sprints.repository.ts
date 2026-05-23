import { sprints } from '../../db/schema/sprints';
import { tasks } from '../../db/schema/tasks';
import { phases } from '../../db/schema/phases';
import { eq, and } from 'drizzle-orm';

export class SprintsRepository {
  static async getSprintById(tx: any, tenantId: string, sprintId: string) {
    const [sprint] = await tx.select().from(sprints).where(and(eq(sprints.id, sprintId), eq(sprints.tenantId, tenantId)));
    return sprint;
  }

  static async getPhaseById(tx: any, tenantId: string, phaseId: string) {
    const [phase] = await tx.select().from(phases).where(and(eq(phases.id, phaseId), eq(phases.tenantId, tenantId)));
    return phase;
  }

  static async getActiveSprintsInPhase(tx: any, tenantId: string, phaseId: string) {
    return await tx.select().from(sprints).where(and(
      eq(sprints.phaseId, phaseId),
      eq(sprints.tenantId, tenantId),
      eq(sprints.status, 'active')
    ));
  }

  static async getIncompleteTasksForSprint(tx: any, tenantId: string, sprintId: string) {
    // Assuming status is 'done' or similar for tasks
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

  static async getSprintsByProjectId(tx: any, tenantId: string, projectId: string) {
    return await tx.select().from(sprints).where(and(eq(sprints.projectId, projectId), eq(sprints.tenantId, tenantId)));
  }
}
