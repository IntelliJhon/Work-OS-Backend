import { qualityGates } from '../../db/schema/quality_gates';
import { eq, and } from 'drizzle-orm';

export class GatesRepository {
  static async getGateById(tx: any, tenantId: string, gateId: string) {
    const [gate] = await tx.select().from(qualityGates).where(and(eq(qualityGates.id, gateId), eq(qualityGates.tenantId, tenantId)));
    return gate;
  }

  static async getGatesByProjectId(tx: any, tenantId: string, projectId: string) {
    return await tx.select().from(qualityGates).where(and(eq(qualityGates.projectId, projectId), eq(qualityGates.tenantId, tenantId)));
  }

  static async updateGateStatus(tx: any, tenantId: string, gateId: string, status: 'pending' | 'approved' | 'rejected' | 'remediation_required' | 'resubmitted', approvedBy?: string) {
    const updateData: any = { status, updatedAt: new Date() };
    if (status === 'approved') {
      updateData.approvedBy = approvedBy;
      updateData.approvedAt = new Date();
    } else {
      updateData.approvedBy = null;
      updateData.approvedAt = null;
    }
    
    const [updatedGate] = await tx.update(qualityGates)
      .set(updateData)
      .where(and(eq(qualityGates.id, gateId), eq(qualityGates.tenantId, tenantId)))
      .returning();
    return updatedGate;
  }

  static async createGatesBulk(tx: any, gatesData: any[]) {
    return await tx.insert(qualityGates).values(gatesData).returning();
  }
}
