import { eq, and } from 'drizzle-orm';
import { phases } from '../db/schema/phases';
import { sprints } from '../db/schema/sprints';
import { qualityGates } from '../db/schema/quality_gates';
import { WorkflowInvariantViolationError, InvalidPhaseTransitionError, SprintConflictError, GateApprovalConflictError } from '../errors/workflow.errors';

export class WorkflowInvariantService {
  /**
   * Run this guard inside a transaction to prevent contradictory workflow states
   */
  static async validateWorkflowState(tx: any, tenantId: string, projectId: string) {
    // Fetch all context data scoped to transaction
    const allPhases = await tx.select().from(phases).where(and(eq(phases.projectId, projectId), eq(phases.tenantId, tenantId)));
    const allSprints = await tx.select().from(sprints).where(and(eq(sprints.projectId, projectId), eq(sprints.tenantId, tenantId)));
    const allGates = await tx.select().from(qualityGates).where(and(eq(qualityGates.projectId, projectId), eq(qualityGates.tenantId, tenantId)));

    const activePhases = allPhases.filter((p: any) => p.status === 'active');
    const activeSprints = allSprints.filter((s: any) => s.status === 'active');

    // 1. Multiple active phases
    if (activePhases.length > 1) {
      throw new WorkflowInvariantViolationError(`Deadlock Prevention: Project cannot have multiple active phases. Found ${activePhases.length}.`);
    }

    for (const phase of allPhases) {
      const phaseSprints = allSprints.filter((s: any) => s.phaseId === phase.id);
      const activePhaseSprints = phaseSprints.filter((s: any) => s.status === 'active');
      const phaseGate = allGates.find((g: any) => g.phaseId === phase.id);

      // 2. Active sprint inside blocked/completed/pending phase
      if (activePhaseSprints.length > 0 && phase.status !== 'active') {
        throw new SprintConflictError(`Sprint Conflict: Cannot have active sprint in ${phase.status} phase.`);
      }

      // 4. Completed phase with active sprint / pending gate
      if (phase.status === 'completed') {
        if (activePhaseSprints.length > 0) {
          throw new InvalidPhaseTransitionError('Phase Consistency: Completed phase still has active sprints.');
        }
        if (phaseGate && phaseGate.status === 'pending') {
          throw new GateApprovalConflictError('Phase Consistency: Completed phase has an unapproved quality gate.');
        }
      }

      // 5. Approved gate while sprint active
      if (phaseGate && phaseGate.status === 'approved' && activePhaseSprints.length > 0) {
        throw new GateApprovalConflictError('Gate Consistency: Quality gate approved while sprints are still active.');
      }
    }

    // 3. Activating next phase while previous sprint active / gate unresolved
    // Since we only allow 1 active phase, let's check sequence integrity
    const activePhase = activePhases[0];
    if (activePhase) {
      const previousPhases = allPhases.filter((p: any) => p.orderIndex < activePhase.orderIndex);
      for (const prev of previousPhases) {
        if (prev.status !== 'completed') {
          throw new InvalidPhaseTransitionError('Sequence Conflict: Active phase exists but previous phase is not completed.');
        }
        const prevGate = allGates.find((g: any) => g.phaseId === prev.id);
        if (prevGate && prevGate.status !== 'approved') {
          throw new GateApprovalConflictError('Sequence Conflict: Previous phase quality gate not approved.');
        }
      }
    }
  }
}
