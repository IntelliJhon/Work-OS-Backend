import { Response, NextFunction } from 'express';
import { NotificationEvents } from '../notifications/notifications.events';
import { emitWorkflowEvent } from '../../socket/eventEmitter';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { PhasesService } from './phases.service';

export class PhasesController {
  static async activate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const phaseId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await PhasesService.activatePhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);
      });
      emitWorkflowEvent({
        type: 'PHASE_ACTIVATED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'phase',
        entityId: phaseId,
        payload: result
      });
      await NotificationEvents.notifyPhaseEvent(tenantId, req.user!.id, result, 'PHASE_ACTIVATED', 'Phase Activated');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async complete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const phaseId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await PhasesService.completePhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);
      });
      emitWorkflowEvent({
        type: 'PHASE_COMPLETED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'phase',
        entityId: phaseId,
        payload: result
      });
      await NotificationEvents.notifyPhaseEvent(tenantId, req.user!.id, result, 'PHASE_COMPLETED', 'Phase Completed');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }


  static async reopen(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const phaseId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await PhasesService.reopenPhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);
      });
      emitWorkflowEvent({
        type: 'PHASE_REOPENED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'phase',
        entityId: phaseId,
        payload: result
      });
      await NotificationEvents.notifyPhaseEvent(tenantId, req.user!.id, result, 'PHASE_REOPENED', 'Phase Reopened');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async block(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const phaseId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await PhasesService.blockPhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);
      });
      emitWorkflowEvent({
        type: 'PHASE_BLOCKED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'phase',
        entityId: phaseId,
        payload: result
      });
      await NotificationEvents.notifyPhaseEvent(tenantId, req.user!.id, result, 'PHASE_BLOCKED', 'Phase Blocked');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
