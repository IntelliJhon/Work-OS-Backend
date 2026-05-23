import { GatesRepository } from './gates.repository';
import { PhasesService } from '../phases/phases.service';
import { PhasesRepository } from '../phases/phases.repository';
import { AuditService } from '../../services/audit.service';
import { WorkflowInvariantService } from '../../services/workflow-invariant.service';
import { NotFoundError, BadRequestError, GateApprovalConflictError } from '../../errors/workflow.errors';
import { projects } from '../../db/schema/projects';
import { uploads } from '../../db/schema/uploads';
import { eq, and } from 'drizzle-orm';

export class GatesService {
  static async approveGate(tx: any, tenantId: string, userId: string, ipAddress: string, gateId: string) {
    const gate = await GatesRepository.getGateById(tx, tenantId, gateId);
    if (!gate) throw new NotFoundError('Gate not found');
    if (gate.status === 'approved') throw new GateApprovalConflictError('Gate is already approved');

    // Check if at least one compliance evidence document has been uploaded
    const gateUploads = await tx.select().from(uploads).where(
      and(
        eq(uploads.tenantId, tenantId),
        eq(uploads.entityType, 'GATE'),
        eq(uploads.entityId, gateId)
      )
    );
    if (gateUploads.length === 0) {
      throw new BadRequestError('Compliance Evidence is not uploaded. Quality Gate cannot be approved.');
    }

    // Approve the gate
    const updatedGate = await GatesRepository.updateGateStatus(tx, tenantId, gateId, 'approved', userId);

    // Get the associated phase
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, gate.phaseId);
    if (!phase) throw new NotFoundError('Associated phase not found');

    // Complete the current phase (this validates it's active)
    await PhasesService.completePhase(tx, tenantId, userId, ipAddress, phase.id);

    // Unlock next phase
    await PhasesService.unlockNextPhase(tx, tenantId, phase.projectId, phase.orderIndex);
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);

    // ── Auto-complete the project when ALL phases are now completed ──────────
    const allPhases = await PhasesRepository.getPhasesByProjectId(tx, tenantId, phase.projectId);
    const allCompleted = allPhases.length > 0 && allPhases.every((p: any) => p.status === 'completed');
    if (allCompleted) {
      const [oldProject] = await tx.select().from(projects).where(
        and(eq(projects.id, phase.projectId), eq(projects.tenantId, tenantId))
      );
      const [completedProject] = await tx.update(projects)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(and(eq(projects.id, phase.projectId), eq(projects.tenantId, tenantId)))
        .returning();
      await AuditService.logAction({
        tenantId, userId, action: 'UPDATE', tableName: 'projects', recordId: phase.projectId,
        oldValue: oldProject, newValue: completedProject, ipAddress,
      }, tx);
    }
    // ─────────────────────────────────────────────────────────────────────────

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'quality_gates', recordId: gateId,
      oldValue: gate, newValue: updatedGate, ipAddress,
    }, tx);

    return updatedGate;
  }

  static async resubmitGate(tx: any, tenantId: string, userId: string, ipAddress: string, gateId: string) {
    const gate = await GatesRepository.getGateById(tx, tenantId, gateId);
    if (!gate) throw new NotFoundError('Gate not found');
    if (gate.status !== 'rejected') throw new BadRequestError('Can only resubmit rejected gates');

    const updatedGate = await GatesRepository.updateGateStatus(tx, tenantId, gateId, 'resubmitted');
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, gate.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'quality_gates', recordId: gateId,
      oldValue: gate, newValue: updatedGate, ipAddress,
    }, tx);
    return updatedGate;
  }


  static async rejectGate(tx: any, tenantId: string, userId: string, ipAddress: string, gateId: string) {
    const gate = await GatesRepository.getGateById(tx, tenantId, gateId);
    if (!gate) throw new NotFoundError('Gate not found');

    const updatedGate = await GatesRepository.updateGateStatus(tx, tenantId, gateId, 'rejected');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'quality_gates', recordId: gateId,
      oldValue: gate, newValue: updatedGate, ipAddress,
    }, tx);

    return updatedGate;
  }

  static async getProjectGates(tx: any, tenantId: string, projectId: string) {
    return await GatesRepository.getGatesByProjectId(tx, tenantId, projectId);
  }
}
