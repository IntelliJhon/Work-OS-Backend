import { db } from '../../db';
import { projects } from '../../db/schema/projects';
import { eq, and } from 'drizzle-orm';
import { NotificationsService } from './notifications.service';
import { logger } from '../../config/logger';
import { withTenant } from '../../middleware/tenant.middleware';

export class NotificationEvents {
  static async notifyPhaseEvent(tenantId: string, actorId: string, phase: any, type: string, title: string) {
    try {
      await withTenant(tenantId, async (tx) => {
        const [project] = await tx.select().from(projects).where(and(eq(projects.id, phase.projectId), eq(projects.tenantId, tenantId)));
        if (!project || !project.pmId) return; // Skip if no owner
        if (project.pmId === actorId) return;

        let priority = 'info';
        if (type === 'PHASE_BLOCKED') priority = 'critical';
        else if (type === 'PHASE_COMPLETED') priority = 'success';
        else if (type === 'PHASE_ACTIVATED' || type === 'PHASE_REOPENED') priority = 'medium';

        await NotificationsService.notify({
          tenantId,
          recipientUserId: project.pmId,
          actorUserId: actorId,
          type,
          title,
          message: `${title} for project: ${project.name}`,
          entityType: 'phase',
          entityId: phase.id,
          priority
        }, tx);
      });
    } catch (err) {
      logger.error({ err, phaseId: phase.id }, 'Failed to trigger phase notification');
    }
  }

  static async notifySprintEvent(tenantId: string, actorId: string, sprint: any, type: string, title: string) {
    try {
      await withTenant(tenantId, async (tx) => {
        const [project] = await tx.select().from(projects).where(and(eq(projects.id, sprint.projectId), eq(projects.tenantId, tenantId)));
        if (!project || !project.pmId) return;
        if (project.pmId === actorId) return;

        let priority = 'medium';
        if (type === 'SPRINT_CANCELLED') priority = 'warning';

        await NotificationsService.notify({
          tenantId,
          recipientUserId: project.pmId,
          actorUserId: actorId,
          type,
          title,
          message: `${title} for project: ${project.name}`,
          entityType: 'sprint',
          entityId: sprint.id,
          priority
        }, tx);
      });
    } catch (err) {
      logger.error({ err, sprintId: sprint.id }, 'Failed to trigger sprint notification');
    }
  }

  static async notifyGateEvent(tenantId: string, actorId: string, gate: any, type: string, title: string) {
    try {
      await withTenant(tenantId, async (tx) => {
        const [project] = await tx.select().from(projects).where(and(eq(projects.id, gate.projectId), eq(projects.tenantId, tenantId)));
        if (!project || !project.pmId) return;
        if (project.pmId === actorId) return;

        let priority = 'info';
        if (type === 'GATE_APPROVED') priority = 'success';
        else if (type === 'GATE_REJECTED') priority = 'critical';
        else if (type === 'GATE_RESUBMITTED') priority = 'warning';

        await NotificationsService.notify({
          tenantId,
          recipientUserId: project.pmId,
          actorUserId: actorId,
          type,
          title,
          message: `${title} for project: ${project.name}`,
          entityType: 'gate',
          entityId: gate.id,
          priority
        }, tx);
      });
    } catch (err) {
      logger.error({ err, gateId: gate.id }, 'Failed to trigger gate notification');
    }
  }

  static async notifyTaskEvent(tenantId: string, actorId: string, oldTask: any, newTask: any) {
    try {
      await withTenant(tenantId, async (tx) => {
        let pmId: string | null = null;
        let projectName = 'Workspace';

        if (newTask.projectId) {
          const [project] = await tx.select().from(projects).where(and(eq(projects.id, newTask.projectId), eq(projects.tenantId, tenantId)));
          if (project) {
            pmId = project.pmId;
            projectName = project.name;
          }
        }

        const createdFrom = (newTask.customFields as any)?.createdFrom || (newTask.sprintId ? 'sprint' : 'sidebar');

        // 1. Task Assigned (creation or reassignment)
        if (!oldTask) {
          // Creation
          if (newTask.assigneeId) {
            await NotificationsService.notify({
              tenantId,
              recipientUserId: newTask.assigneeId,
              actorUserId: actorId,
              type: 'TASK_ASSIGNED',
              title: newTask.sprintId ? 'New Sprint Task Assigned' : 'New Task Assigned',
              message: `"${newTask.name}" has been assigned to you.`,
              entityType: 'task',
              entityId: newTask.id,
              priority: 'info',
              metadata: {
                projectName,
                taskName: newTask.name,
                sprintId: newTask.sprintId,
                projectId: newTask.projectId,
                createdFrom
              }
            }, tx);
          }
        } else {
          // Update
          // A. Reassigned
          if (newTask.assigneeId && newTask.assigneeId !== oldTask.assigneeId) {
            await NotificationsService.notify({
              tenantId,
              recipientUserId: newTask.assigneeId,
              actorUserId: actorId,
              type: 'TASK_REASSIGNED',
              title: newTask.sprintId ? 'Sprint Task Reassigned' : 'Task Reassigned',
              message: `"${newTask.name}" has been reassigned to you.`,
              entityType: 'task',
              entityId: newTask.id,
              priority: 'info',
              metadata: {
                projectName,
                taskName: newTask.name,
                sprintId: newTask.sprintId,
                projectId: newTask.projectId,
                createdFrom
              }
            }, tx);
          }

          // B. Blocked
          if (newTask.status === 'blocked' && oldTask.status !== 'blocked') {
            // Notify Assignee
            if (newTask.assigneeId && newTask.assigneeId !== actorId) {
              await NotificationsService.notify({
                tenantId,
                recipientUserId: newTask.assigneeId,
                actorUserId: actorId,
                type: 'TASK_BLOCKED',
                title: newTask.sprintId ? 'Sprint Task Blocked' : 'Task Blocked',
                message: `"${newTask.name}" is now blocked.`,
                entityType: 'task',
                entityId: newTask.id,
                priority: 'warning',
                metadata: {
                  projectName,
                  taskName: newTask.name,
                  sprintId: newTask.sprintId,
                  projectId: newTask.projectId,
                  createdFrom
                }
              }, tx);
            }

            // Notify PM (if not actor)
            if (pmId && pmId !== actorId) {
              await NotificationsService.notify({
                tenantId,
                recipientUserId: pmId,
                actorUserId: actorId,
                type: 'TASK_BLOCKED',
                title: newTask.sprintId ? 'Sprint Task Blocked' : 'Task Blocked',
                message: `"${newTask.name}" in project "${projectName}" is now blocked.`,
                entityType: 'task',
                entityId: newTask.id,
                priority: 'critical',
                metadata: {
                  projectName,
                  taskName: newTask.name,
                  sprintId: newTask.sprintId,
                  projectId: newTask.projectId,
                  createdFrom
                }
              }, tx);
            }
          }

          // C. Completed
          if ((newTask.status === 'completed' || newTask.status === 'done') && oldTask.status !== 'completed' && oldTask.status !== 'done') {
            // Notify PM (if not actor)
            if (pmId && pmId !== actorId) {
              await NotificationsService.notify({
                tenantId,
                recipientUserId: pmId,
                actorUserId: actorId,
                type: 'TASK_COMPLETED',
                title: newTask.sprintId ? 'Sprint Task Completed' : 'Task Completed',
                message: `"${newTask.name}" in project "${projectName}" has been completed.`,
                entityType: 'task',
                entityId: newTask.id,
                priority: 'success',
                metadata: {
                  projectName,
                  taskName: newTask.name,
                  sprintId: newTask.sprintId,
                  projectId: newTask.projectId,
                  createdFrom
                }
              }, tx);
            }
          }
        }
      });
    } catch (err) {
      logger.error({ err, taskId: newTask.id }, 'Failed to trigger task notification event');
    }
  }
}

