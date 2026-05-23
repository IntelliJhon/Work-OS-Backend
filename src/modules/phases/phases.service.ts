import { PhasesRepository } from './phases.repository';
import { SprintsRepository } from '../sprints/sprints.repository';
import { GatesRepository } from '../gates/gates.repository';
import { ProjectsRepository } from '../projects/projects.repository';
import { AuditService } from '../../services/audit.service';
import { WorkflowInvariantService } from '../../services/workflow-invariant.service';
import { NotFoundError, BadRequestError, InvalidPhaseTransitionError, ConflictError } from '../../errors/workflow.errors';


export class PhasesService {
  static async activatePhase(tx: any, tenantId: string, userId: string, ipAddress: string, phaseId: string) {
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, phaseId);
    if (!phase) throw new NotFoundError('Phase not found');

    if (phase.status === 'completed') throw new InvalidPhaseTransitionError('Cannot activate an already completed phase');
    if (phase.status === 'active') throw new InvalidPhaseTransitionError('Phase is already active');

    // Fetch all project phases once (needed for multiple checks below)
    const allPhases = await PhasesRepository.getPhasesByProjectId(tx, tenantId, phase.projectId);
    const previousPhase = allPhases.find((p: any) => p.orderIndex === phase.orderIndex - 1);

    // ── Self-Healing Lock Check ─────────────────────────────────────────────
    // If the phase is locked, check whether the previous phase is already completed.
    // If it is, the lock is stale (e.g. unlockNextPhase was never called) and we
    // can safely clear it here before proceeding.
    if (phase.isLocked) {
      const previousIsComplete = !previousPhase || previousPhase.status === 'completed';
      if (!previousIsComplete) {
        throw new InvalidPhaseTransitionError(
          'Cannot activate a locked phase. Ensure the previous phase is completed first.'
        );
      }
      // Auto-unlock the stale lock so we can proceed
      await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'pending', false);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Ensure no other phase is active
    const activePhase = allPhases.find((p: any) => p.status === 'active');
    if (activePhase) throw new ConflictError('Another phase is currently active in this project');

    // Ensure sequence is followed
    if (previousPhase && previousPhase.status !== 'completed') {
      throw new InvalidPhaseTransitionError('Previous phase must be completed before activating this phase');
    }

    const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'active', false);
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: phaseId,
      oldValue: phase, newValue: updatedPhase, ipAddress,
    }, tx);

    return updatedPhase;
  }

  static async completePhase(tx: any, tenantId: string, userId: string, ipAddress: string, phaseId: string) {
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, phaseId);
    if (!phase) throw new NotFoundError('Phase not found');
    if (phase.status !== 'active') throw new InvalidPhaseTransitionError('Only active phases can be completed');

    // ── Gate Approval Guard ──────────────────────────────────────────────────
    // A phase can only be completed if its quality gate checklist is APPROVED.
    const gates = await GatesRepository.getGatesByProjectId(tx, tenantId, phase.projectId);
    const phaseGate = gates.find((g: any) => g.phaseId === phaseId);
    if (phaseGate && phaseGate.status !== 'approved') {
      throw new BadRequestError(
        `Phase "${phase.name}" cannot be completed: its quality gate checklist has not been approved yet (current status: "${phaseGate.status}"). Please approve the gate before locking this phase.`
      );
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Automatically close any active sprints in this phase
    const activeSprints = await SprintsRepository.getActiveSprintsInPhase(tx, tenantId, phaseId);
    for (const sprint of activeSprints) {
      const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprint.id, 'closed');
      await AuditService.logAction({
        tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprint.id,
        oldValue: sprint, newValue: updatedSprint, ipAddress,
      }, tx);
    }

    // Complete current phase (isLocked=false — the phase itself is done, not locked)
    const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'completed', false);

    // ── Always unlock the next phase ────────────────────────────────────────
    // Called here (not just in approveGate) so that any completion path
    // (manual or gate-driven) correctly unlocks the following phase.
    await PhasesService.unlockNextPhase(tx, tenantId, phase.projectId, phase.orderIndex);
    // ─────────────────────────────────────────────────────────────────────────

    // Check if all phases in the project are completed, and if so, complete the project
    const allPhases = await PhasesRepository.getPhasesByProjectId(tx, tenantId, phase.projectId);
    const allCompleted = allPhases.every((p: any) => p.status === 'completed');
    if (allCompleted) {
      const projectBefore = await ProjectsRepository.findProjectById(tx, tenantId, phase.projectId);
      if (projectBefore && projectBefore.status !== 'completed') {
        const updatedProject = await ProjectsRepository.updateProject(tx, tenantId, phase.projectId, { status: 'completed' });
        await AuditService.logAction({
          tenantId, userId, action: 'UPDATE', tableName: 'projects', recordId: phase.projectId,
          oldValue: projectBefore, newValue: updatedProject, ipAddress,
        }, tx);
      }
    }

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: phaseId,
      oldValue: phase, newValue: updatedPhase, ipAddress,
    }, tx);

    return updatedPhase;
  }

  static async blockPhase(tx: any, tenantId: string, userId: string, ipAddress: string, phaseId: string) {
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, phaseId);
    if (!phase) throw new NotFoundError('Phase not found');
    if (phase.status === 'completed') throw new InvalidPhaseTransitionError('Cannot block a completed phase');
    if (phase.status === 'blocked') throw new InvalidPhaseTransitionError('Phase is already blocked');
    if (phase.status === 'pending') throw new InvalidPhaseTransitionError('Cannot block a pending phase — activate it first');

    // Block the phase (keep isLocked=false so it can be unblocked/reactivated)
    const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'blocked', false);
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: phaseId,
      oldValue: phase, newValue: updatedPhase, ipAddress,
    }, tx);

    return updatedPhase;
  }


  static async reopenPhase(tx: any, tenantId: string, userId: string, ipAddress: string, phaseId: string) {
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, phaseId);
    if (!phase) throw new NotFoundError('Phase not found');
    if (phase.status === 'active') throw new InvalidPhaseTransitionError('Phase is already active');

    // Rule: no conflicting active phase exists
    const allPhases = await PhasesRepository.getPhasesByProjectId(tx, tenantId, phase.projectId);
    const activePhase = allPhases.find((p: any) => p.status === 'active');
    if (activePhase) throw new ConflictError('Cannot reopen: Another phase is currently active');

    // 1. Reset the associated quality gate to pending if it exists
    const gates = await GatesRepository.getGatesByProjectId(tx, tenantId, phase.projectId);
    const associatedGate = gates.find((g: any) => g.phaseId === phaseId);
    if (associatedGate) {
      const updatedGate = await GatesRepository.updateGateStatus(tx, tenantId, associatedGate.id, 'pending');
      await AuditService.logAction({
        tenantId, userId, action: 'UPDATE', tableName: 'quality_gates', recordId: associatedGate.id,
        oldValue: associatedGate, newValue: updatedGate, ipAddress,
      }, tx);
    }

    // 2. Lock all subsequent phases in the project
    const subsequentPhases = allPhases.filter((p: any) => p.orderIndex > phase.orderIndex);
    for (const subPhase of subsequentPhases) {
      if (subPhase.status !== 'pending' || !subPhase.isLocked) {
        const updatedSubPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, subPhase.id, 'pending', true);
        await AuditService.logAction({
          tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: subPhase.id,
          oldValue: subPhase, newValue: updatedSubPhase, ipAddress,
        }, tx);
      }
    }

    const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'active', false);

    // If the project was previously completed, revert it back to active
    const projectBefore = await ProjectsRepository.findProjectById(tx, tenantId, phase.projectId);
    if (projectBefore && projectBefore.status === 'completed') {
      const updatedProject = await ProjectsRepository.updateProject(tx, tenantId, phase.projectId, { status: 'active' });
      await AuditService.logAction({
        tenantId, userId, action: 'UPDATE', tableName: 'projects', recordId: phase.projectId,
        oldValue: projectBefore, newValue: updatedProject, ipAddress,
      }, tx);
    }

    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: phaseId,
      oldValue: phase, newValue: updatedPhase, ipAddress,
    }, tx);
    return updatedPhase;
  }

  static async unlockNextPhase(tx: any, tenantId: string, projectId: string, currentOrderIndex: number) {
    const allPhases = await PhasesRepository.getPhasesByProjectId(tx, tenantId, projectId);
    const nextPhase = allPhases.find((p: any) => p.orderIndex === currentOrderIndex + 1);
    
    if (nextPhase) {
      await PhasesRepository.updatePhaseStatus(tx, tenantId, nextPhase.id, 'pending', false);
    }
  }
}
