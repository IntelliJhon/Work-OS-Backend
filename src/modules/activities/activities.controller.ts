import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { ActivitiesService } from './activities.service';
import { emitWorkflowEvent } from '../../socket/eventEmitter';

export class ActivitiesController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      // Drizzle's PgTimestamp.mapToDriverValue() requires a Date object (not a string).
      // Convert ISO strings coming from req.body before passing to the ORM.
      const body = { ...req.body };
      if (body.startDate) body.startDate = new Date(body.startDate);
      else body.startDate = null;
      if (body.endDate) body.endDate = new Date(body.endDate);
      else body.endDate = null;

      const result = await withTenant(tenantId, async (tx) => {
        return await ActivitiesService.createActivity(tx, tenantId, req.user!.id, req.ip || '', body);
      });

      emitWorkflowEvent({
        type: 'ACTIVITY_CREATED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'activity',
        entityId: result.id,
        payload: result
      });

      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async listByProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.projectId as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await ActivitiesService.getActivities(tx, tenantId, projectId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const activityId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await ActivitiesService.deleteActivity(tx, tenantId, req.user!.id, req.ip || '', activityId);
      });

      emitWorkflowEvent({
        type: 'ACTIVITY_DELETED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'activity',
        entityId: activityId,
        payload: result
      });

      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}
