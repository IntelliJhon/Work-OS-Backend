import { tasks } from '../../db/schema/tasks';
import { AuditService } from '../../services/audit.service';
import { NotificationEvents } from '../notifications/notifications.events';
import { getIoInstance } from '../../socket/socketServer';
import { logger } from '../../config/logger';

export interface CreateTaskOptions {
  tenantId: string;
  actorUserId: string;
  actorName: string;
  values: Omit<typeof tasks.$inferInsert, 'tenantId'>;
  ipAddress?: string;
}

/**
 * Inserts a task inside a tenant-scoped transaction (see withTenant) with the same side effects everywhere:
 * audit log, assignment notifications and the realtime kanban broadcast.
 * The task number (W-<n>) is assigned by the database trigger.
 */
export async function createTaskInTx(tx: any, { tenantId, actorUserId, actorName, values, ipAddress }: CreateTaskOptions) {
  const completedAt = values.status === 'done' ? new Date() : null;
  const [newTask] = await tx.insert(tasks).values({
    tenantId,
    ...values,
    completedAt,
  }).returning();

  await AuditService.logAction({
    tenantId,
    userId: actorUserId,
    action: 'INSERT',
    tableName: 'tasks',
    recordId: newTask.id,
    newValue: newTask,
    ipAddress,
  }, tx);

  await NotificationEvents.notifyTaskEvent(tenantId, actorUserId, null, newTask);

  try {
    const io = getIoInstance();
    const room = newTask.projectId ? `project:${newTask.projectId}` : `tenant:${tenantId}`;
    io.to(room).emit('kanban_task_created_received', {
      sprintId: newTask.sprintId,
      task: newTask,
      actorName,
    });
  } catch (socketErr: any) {
    logger.warn({ msg: 'Socket creation broadcast skipped', err: socketErr.message });
  }

  return newTask as typeof tasks.$inferSelect;
}

export const formatWorkId = (taskNumber: number | null | undefined): string | null =>
  taskNumber ? `W-${taskNumber}` : null;
