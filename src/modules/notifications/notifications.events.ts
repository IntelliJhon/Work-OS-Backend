import { db } from '../../db';
import { projects } from '../../db/schema/projects';
import { users } from '../../db/schema/users';
import { eq, and } from 'drizzle-orm';
import { NotificationsService } from './notifications.service';
import { logger } from '../../config/logger';
import { withTenant } from '../../middleware/tenant.middleware';
import { WhatsAppService } from '../../services/whatsapp.service';
import { WhatsAppBotsService } from '../whatsapp-bots/whatsapp-bots.service';
import { maskPhone } from '../../lib/phone';
import { env } from '../../config/env';

/** WhatsApp to whoever assigned a task that is now done (after the notification transaction) */
async function sendWorkDoneWhatsApp(tenantId: string, to: { firstName: string; phone: string }, task: any, doneBy: string) {
  try {
    const workId = task.taskNumber ? `W-${task.taskNumber}` : 'Your work';
    const wa = await WhatsAppBotsService.forTenant(tenantId);
    const sent = await WhatsAppService.sendBodyTemplate(
      to.phone, env.WHATSAPP_WORK_DONE_TEMPLATE, wa.templates.lang, [to.firstName, workId, task.name, doneBy], wa.sender,
    );
    if (!sent.success) logger.warn({ to: maskPhone(to.phone), taskId: task.id, error: sent.error }, '[TaskDone] WhatsApp to assigner failed');
  } catch (err) {
    logger.error({ err, taskId: task.id }, '[TaskDone] WhatsApp to assigner failed');
  }
}

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
    // WhatsApp messages to send once the notifications are saved
    const whatsapp: { firstName: string; phone: string }[] = [];
    let doneByName = 'Someone';
    try {
      await withTenant(tenantId, async (tx) => {
        let pmId: string | null = null;
        let projectName = 'Workspace';
        let actorName = 'Someone';

        if (newTask.projectId) {
          const [project] = await tx.select().from(projects).where(and(eq(projects.id, newTask.projectId), eq(projects.tenantId, tenantId)));
          if (project) {
            pmId = project.pmId;
            projectName = project.name;
          }
        }

        if (actorId) {
          const [actor] = await tx.select().from(users).where(eq(users.id, actorId));
          if (actor) {
            actorName = `${actor.firstName} ${actor.lastName}`;
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
              message: `"${newTask.name}" has been assigned to you by ${actorName}.`,
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
              message: `"${newTask.name}" has been reassigned to you by ${actorName}.`,
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
            const workId = newTask.taskNumber ? `W-${newTask.taskNumber}` : null;
            doneByName = actorName;
            // Whoever assigned it (unless they marked it done themselves): in-app + WhatsApp
            const assignerId: string | null = newTask.assignedBy ?? null;
            if (assignerId && assignerId !== actorId) {
              const [assigner] = await tx
                .select({ firstName: users.firstName, phone: users.phone, deletedAt: users.deletedAt })
                .from(users)
                .where(eq(users.id, assignerId));
              if (assigner && !assigner.deletedAt) {
                await NotificationsService.notify({
                  tenantId,
                  recipientUserId: assignerId,
                  actorUserId: actorId,
                  type: 'TASK_COMPLETED',
                  title: `Work done: ${workId ? `${workId} · ` : ''}${newTask.name}`.slice(0, 250),
                  message: `"${newTask.name}" was marked as done by ${actorName}.`,
                  entityType: 'task',
                  entityId: newTask.id,
                  priority: 'success',
                  metadata: { projectName, taskName: newTask.name, sprintId: newTask.sprintId, projectId: newTask.projectId, createdFrom },
                }, tx);
                if (assigner.phone) whatsapp.push({ firstName: assigner.firstName, phone: assigner.phone });
              }
            }
            // Notify PM (if not actor, and not already told as the assigner)
            if (pmId && pmId !== actorId && pmId !== assignerId) {
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
    // Not awaited: a slow WhatsApp send never delays saving the task
    for (const to of whatsapp) void sendWorkDoneWhatsApp(tenantId, to, newTask, doneByName);
  }
}

