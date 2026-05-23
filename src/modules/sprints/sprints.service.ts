import { SprintsRepository } from './sprints.repository';
import { AuditService } from '../../services/audit.service';
import { WorkflowInvariantService } from '../../services/workflow-invariant.service';
import { NotFoundError, BadRequestError, ConflictError, SprintConflictError } from '../../errors/workflow.errors';

export class SprintsService {
  static async startSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new NotFoundError('Sprint not found');
    if (sprint.status !== 'planning') throw new BadRequestError('Can only start sprints in planning state');

    const phase = await SprintsRepository.getPhaseById(tx, tenantId, sprint.phaseId);
    if (!phase) throw new NotFoundError('Parent phase not found');
    
    // Rule: sprint cannot start if parent phase is locked, pending, completed
    if (phase.status !== 'active') throw new BadRequestError('Cannot start sprint unless parent phase is active');
    if (phase.isLocked) throw new BadRequestError('Cannot start sprint in a locked phase');

    // Rule: no overlapping active sprint (default disabled)
    const activeSprints = await SprintsRepository.getActiveSprintsInPhase(tx, tenantId, sprint.phaseId);
    if (activeSprints.length > 0) throw new SprintConflictError('Another sprint is already active in this phase');

    const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'active');
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, sprint.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprintId,
      oldValue: sprint, newValue: updatedSprint, ipAddress,
    }, tx);

    return updatedSprint;
  }

  static async closeSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new NotFoundError('Sprint not found');
    if (sprint.status !== 'active') throw new BadRequestError('Can only close active sprints');

    // Validation: Enforce all sprint tasks completed before closure
    const incompleteTasks = await SprintsRepository.getIncompleteTasksForSprint(tx, tenantId, sprintId);
    if (incompleteTasks.length > 0) {
      throw new ConflictError(`Cannot close sprint. ${incompleteTasks.length} tasks remain incomplete.`);
    }

    const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'closed');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprintId,
      oldValue: sprint, newValue: updatedSprint, ipAddress,
    }, tx);

    return updatedSprint;
  }


  static async reopenSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new NotFoundError('Sprint not found');
    if (sprint.status !== 'closed') throw new BadRequestError('Can only reopen closed sprints');

    const phase = await SprintsRepository.getPhaseById(tx, tenantId, sprint.phaseId);
    if (phase.status !== 'active') throw new BadRequestError('Cannot reopen sprint: parent phase is no longer active');

    const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'active');
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, sprint.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprintId,
      oldValue: sprint, newValue: updatedSprint, ipAddress,
    }, tx);
    return updatedSprint;
  }

  static async cancelSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new NotFoundError('Sprint not found');

    const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'cancelled');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprintId,
      oldValue: sprint, newValue: updatedSprint, ipAddress,
    }, tx);

    return updatedSprint;
  }

  static async createSprint(tx: any, tenantId: string, userId: string, ipAddress: string, data: any) {
    const sprint = await SprintsRepository.createSprint(tx, tenantId, data);
    
    await AuditService.logAction({
      tenantId, userId, action: 'INSERT', tableName: 'sprints', recordId: sprint.id,
      newValue: sprint, ipAddress,
    }, tx);
    
    return sprint;
  }

  static async getSprints(tx: any, tenantId: string, projectId: string) {
    return await SprintsRepository.getSprintsByProjectId(tx, tenantId, projectId);
  }
}
