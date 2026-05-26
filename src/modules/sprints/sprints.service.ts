import { SprintsRepository } from './sprints.repository';
import { AuditService } from '../../services/audit.service';
import { WorkflowInvariantService } from '../../services/workflow-invariant.service';
import { NotFoundError, BadRequestError, ConflictError, SprintConflictError } from '../../errors/workflow.errors';

export class SprintsService {
  static async startSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new NotFoundError('Sprint not found');
    if (sprint.status !== 'planning') throw new BadRequestError('Can only start sprints in planning state');

    const activity = await SprintsRepository.getActivityById(tx, tenantId, sprint.activityId);
    if (!activity) throw new NotFoundError('Parent activity not found');
    
    // Rule: no overlapping active sprint in this activity
    const activeSprints = await SprintsRepository.getActiveSprintsInActivity(tx, tenantId, sprint.activityId);
    if (activeSprints.length > 0) throw new SprintConflictError('Another sprint cycle is already active in this activity');

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

    const activity = await SprintsRepository.getActivityById(tx, tenantId, sprint.activityId);
    if (!activity) throw new NotFoundError('Parent activity not found');

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

  static async getSprintsByActivity(tx: any, tenantId: string, activityId: string) {
    return await SprintsRepository.getSprintsByActivityId(tx, tenantId, activityId);
  }

  static async getSprintsByProject(tx: any, tenantId: string, projectId: string) {
    return await SprintsRepository.getSprintsByProjectId(tx, tenantId, projectId);
  }
}
