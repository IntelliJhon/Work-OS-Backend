import { Response, NextFunction } from 'express';
import { NotificationEvents } from '../notifications/notifications.events';
import { emitWorkflowEvent } from '../../socket/eventEmitter';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { GatesService } from './gates.service';

export class GatesController {
  static async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const gateId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await GatesService.approveGate(tx, tenantId, req.user!.id, req.ip || '', gateId);
      });
      emitWorkflowEvent({
        type: 'GATE_APPROVED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'gate',
        entityId: gateId,
        payload: result
      });
      await NotificationEvents.notifyGateEvent(tenantId, req.user!.id, result, 'GATE_APPROVED', 'Gate Approved');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const gateId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await GatesService.rejectGate(tx, tenantId, req.user!.id, req.ip || '', gateId);
      });
      emitWorkflowEvent({
        type: 'GATE_REJECTED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'gate',
        entityId: gateId,
        payload: result
      });
      await NotificationEvents.notifyGateEvent(tenantId, req.user!.id, result, 'GATE_REJECTED', 'Gate Rejected');

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }


  static async resubmit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const gateId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await GatesService.resubmitGate(tx, tenantId, req.user!.id, req.ip || '', gateId);
      });
      emitWorkflowEvent({
        type: 'GATE_RESUBMITTED',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: 'gate',
        entityId: gateId,
        payload: result
      });
      await NotificationEvents.notifyGateEvent(tenantId, req.user!.id, result, 'GATE_RESUBMITTED', 'Gate Resubmitted');

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
        return await GatesService.getProjectGates(tx, tenantId, projectId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
