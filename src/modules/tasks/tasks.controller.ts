import { Response, NextFunction } from 'express';
import { db } from '../../db';
import { tasks } from '../../db/schema/tasks';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { NotificationEvents } from '../notifications/notifications.events';
import { eq, and } from 'drizzle-orm';
import { ForbiddenError, NotFoundError } from '../../errors/workflow.errors';
import { TaskOwnershipService } from './task-ownership.service';
import { getIoInstance } from '../../socket/socketServer';
import { logger } from '../../config/logger';

export class TasksController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        const [newTask] = await tx.insert(tasks).values({
          tenantId,
          ...req.body,
        }).returning();

        // Audit Logging
        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'INSERT',
          tableName: 'tasks',
          recordId: newTask.id,
          newValue: newTask,
          ipAddress: req.ip,
        }, tx);

        // Trigger notifications
        await NotificationEvents.notifyTaskEvent(tenantId, req.user!.id, null, newTask);

        // Broadcast real-time Socket.IO event
        try {
          const io = getIoInstance();
          const actorName = req.user ? `${(req.user as any).firstName || ''} ${(req.user as any).lastName || ''}`.trim() || (req.user as any).email || req.user.role : 'System';
          const room = newTask.projectId ? `project:${newTask.projectId}` : `tenant:${tenantId}`;
          io.to(room).emit('kanban_task_created_received', {
            sprintId: newTask.sprintId,
            task: newTask,
            actorName,
          });
        } catch (socketErr: any) {
          logger.warn({ msg: 'Socket creation broadcast skipped', err: socketErr.message });
        }

        return newTask;
      });

      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        return await tx.select().from(tasks);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const id = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        const [oldTask] = await tx.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)));
        if (!oldTask) {
          throw new NotFoundError('Task not found');
        }

        // Determine if user can update the task and get their access level
        const accessLevel = await TaskOwnershipService.getAccessLevel(
          tx,
          tenantId,
          req.user!.id,
          req.user!.role,
          req.user!.permissions ?? {},
          id,
        );

        if (accessLevel === 'none') {
          throw new ForbiddenError('You are not allowed to update this task');
        }

        // Apply strict assignee validation if they only have assignee access level
        if (accessLevel === 'assignee') {
          TaskOwnershipService.validateAssigneeUpdates(req.body, oldTask);
        }

        // Filter updates based on access level
        const allowedUpdates = TaskOwnershipService.filterAllowedUpdates(accessLevel, req.body, oldTask);

        // If nothing is being updated, return unchanged
        if (Object.keys(allowedUpdates).length === 0) {
          return oldTask;
        }

        const [updatedTask] = await tx
          .update(tasks)
          .set({ ...allowedUpdates, updatedAt: new Date() })
          .where(eq(tasks.id, id))
          .returning();

        // Audit Logging with oldValue and newValue to trace state transitions
        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'UPDATE',
          tableName: 'tasks',
          recordId: id,
          oldValue: oldTask,
          newValue: updatedTask,
          ipAddress: req.ip,
        }, tx);

        // Trigger notifications
        await NotificationEvents.notifyTaskEvent(tenantId, req.user!.id, oldTask, updatedTask);

        // Broadcast real-time Socket.IO events
        try {
          const io = getIoInstance();
          const actorName = req.user ? `${(req.user as any).firstName || ''} ${(req.user as any).lastName || ''}`.trim() || (req.user as any).email || req.user.role : 'System';
          const room = updatedTask.projectId ? `project:${updatedTask.projectId}` : `tenant:${tenantId}`;

          io.to(room).emit('kanban_task_updated_received', {
            sprintId: updatedTask.sprintId,
            taskId: updatedTask.id,
            updates: allowedUpdates,
            actorName,
          });

          if (oldTask.status !== updatedTask.status) {
            io.to(room).emit('kanban_task_moved_received', {
              taskId: updatedTask.id,
              fromStatus: oldTask.status,
              toStatus: updatedTask.status,
              actorName,
            });
          }
        } catch (socketErr: any) {
          logger.warn({ msg: 'Socket update broadcast skipped', err: socketErr.message });
        }

        return updatedTask;
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const id = req.params.id as string;

      await withTenant(tenantId, async (tx) => {
        const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)));
        if (!task) {
          throw new NotFoundError('Task not found');
        }

        // Determine if user is authorized to delete
        const accessLevel = await TaskOwnershipService.getAccessLevel(
          tx,
          tenantId,
          req.user!.id,
          req.user!.role,
          req.user!.permissions ?? {},
          id,
        );

        if (accessLevel !== 'admin' && accessLevel !== 'project_manager') {
          throw new ForbiddenError('You are not allowed to update this task');
        }

        await tx.delete(tasks).where(eq(tasks.id, id));

        // Audit Logging
        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'DELETE',
          tableName: 'tasks',
          recordId: id,
          oldValue: task,
          ipAddress: req.ip,
        }, tx);

        // Broadcast real-time Socket.IO delete event
        try {
          const io = getIoInstance();
          const room = task.projectId ? `project:${task.projectId}` : `tenant:${tenantId}`;
          io.to(room).emit('kanban_task_deleted_received', {
            sprintId: task.sprintId,
            taskId: task.id,
          });
        } catch (socketErr: any) {
          logger.warn({ msg: 'Socket delete broadcast skipped', err: socketErr.message });
        }
      });

      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}
