import { phases } from '../../db/schema/phases';
import { eq, and, asc } from 'drizzle-orm';

export class PhasesRepository {
  static async getPhaseById(tx: any, tenantId: string, phaseId: string) {
    const [phase] = await tx.select().from(phases).where(and(eq(phases.id, phaseId), eq(phases.tenantId, tenantId)));
    return phase;
  }

  static async getPhasesByProjectId(tx: any, tenantId: string, projectId: string) {
    return await tx.select().from(phases).where(and(eq(phases.projectId, projectId), eq(phases.tenantId, tenantId))).orderBy(asc(phases.orderIndex));
  }

  static async updatePhaseStatus(tx: any, tenantId: string, phaseId: string, status: 'pending' | 'active' | 'completed' | 'blocked', isLocked?: boolean) {
    const updateData: any = { status, updatedAt: new Date() };
    if (isLocked !== undefined) updateData.isLocked = isLocked;
    
    const [updatedPhase] = await tx.update(phases)
      .set(updateData)
      .where(and(eq(phases.id, phaseId), eq(phases.tenantId, tenantId)))
      .returning();
    return updatedPhase;
  }
}
