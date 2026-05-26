import { Response, NextFunction } from 'express';
import { NotificationEvents } from '../notifications/notifications.events';
import { emitWorkflowEvent } from '../../socket/eventEmitter';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { SprintsService } from './sprints.service';

export class SprintsController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.createSprint(tx, tenantId, req.user!.id, req.ip || '', req.body);
      });

      emitWorkflowEvent({
        type: 'SPRINT_CREATED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'sprint',
        entityId: result.id,
        payload: result
      });

      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async listByActivity(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const activityId = req.params.activityId as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.getSprintsByActivity(tx, tenantId, activityId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async listByProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.projectId as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.getSprintsByProject(tx, tenantId, projectId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async start(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const sprintId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.startSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);
      });
      emitWorkflowEvent({
        type: 'SPRINT_STARTED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'sprint',
        entityId: sprintId,
        payload: result
      });
      await NotificationEvents.notifySprintEvent(tenantId, req.user!.id, result, 'SPRINT_STARTED', 'Sprint Started');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async close(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const sprintId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.closeSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);
      });
      emitWorkflowEvent({
        type: 'SPRINT_CLOSED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'sprint',
        entityId: sprintId,
        payload: result
      });
      await NotificationEvents.notifySprintEvent(tenantId, req.user!.id, result, 'SPRINT_CLOSED', 'Sprint Closed');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async reopen(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const sprintId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.reopenSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);
      });
      emitWorkflowEvent({
        type: 'SPRINT_REOPENED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'sprint',
        entityId: sprintId,
        payload: result
      });
      await NotificationEvents.notifySprintEvent(tenantId, req.user!.id, result, 'SPRINT_REOPENED', 'Sprint Reopened');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async cancel(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const sprintId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.cancelSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);
      });
      emitWorkflowEvent({
        type: 'SPRINT_CANCELLED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'sprint',
        entityId: sprintId,
        payload: result
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
