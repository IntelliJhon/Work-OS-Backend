const fs = require('fs');
const path = require('path');

const repo = `import { qualityGates } from '../../db/schema/quality_gates';
import { eq, and } from 'drizzle-orm';

export class GatesRepository {
  static async getGateById(tx: any, tenantId: string, gateId: string) {
    const [gate] = await tx.select().from(qualityGates).where(and(eq(qualityGates.id, gateId), eq(qualityGates.tenantId, tenantId)));
    return gate;
  }

  static async getGatesByProjectId(tx: any, tenantId: string, projectId: string) {
    return await tx.select().from(qualityGates).where(and(eq(qualityGates.projectId, projectId), eq(qualityGates.tenantId, tenantId)));
  }

  static async updateGateStatus(tx: any, tenantId: string, gateId: string, status: 'pending' | 'approved' | 'rejected', approvedBy?: string) {
    const updateData: any = { status, updatedAt: new Date() };
    if (status === 'approved') {
      updateData.approvedBy = approvedBy;
      updateData.approvedAt = new Date();
    }
    
    const [updatedGate] = await tx.update(qualityGates)
      .set(updateData)
      .where(and(eq(qualityGates.id, gateId), eq(qualityGates.tenantId, tenantId)))
      .returning();
    return updatedGate;
  }

  static async createGatesBulk(tx: any, gatesData: any[]) {
    return await tx.insert(qualityGates).values(gatesData).returning();
  }
}
`;

const service = `import { GatesRepository } from './gates.repository';
import { PhasesService } from '../phases/phases.service';
import { PhasesRepository } from '../phases/phases.repository';
import { AuditService } from '../../services/audit.service';

export class GatesService {
  static async approveGate(tx: any, tenantId: string, userId: string, ipAddress: string, gateId: string) {
    const gate = await GatesRepository.getGateById(tx, tenantId, gateId);
    if (!gate) throw new Error('Gate not found');
    if (gate.status === 'approved') throw new Error('Gate is already approved');

    // Approve the gate
    const updatedGate = await GatesRepository.updateGateStatus(tx, tenantId, gateId, 'approved', userId);

    // Get the associated phase
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, gate.phaseId);
    if (!phase) throw new Error('Associated phase not found');

    // Complete the current phase (this validates it's active)
    await PhasesService.completePhase(tx, tenantId, userId, ipAddress, phase.id);

    // Unlock next phase
    await PhasesService.unlockNextPhase(tx, tenantId, phase.projectId, phase.orderIndex);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'quality_gates', recordId: gateId,
      oldValue: gate, newValue: updatedGate, ipAddress,
    });

    return updatedGate;
  }

  static async rejectGate(tx: any, tenantId: string, userId: string, ipAddress: string, gateId: string) {
    const gate = await GatesRepository.getGateById(tx, tenantId, gateId);
    if (!gate) throw new Error('Gate not found');

    const updatedGate = await GatesRepository.updateGateStatus(tx, tenantId, gateId, 'rejected');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'quality_gates', recordId: gateId,
      oldValue: gate, newValue: updatedGate, ipAddress,
    });

    return updatedGate;
  }

  static async getProjectGates(tx: any, tenantId: string, projectId: string) {
    return await GatesRepository.getGatesByProjectId(tx, tenantId, projectId);
  }
}
`;

const controller = `import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { GatesService } from './gates.service';

export class GatesController {
  static async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const gateId = req.params.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await GatesService.approveGate(tx, tenantId, req.user!.id, req.ip || '', gateId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const gateId = req.params.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await GatesService.rejectGate(tx, tenantId, req.user!.id, req.ip || '', gateId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async listByProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const projectId = req.params.projectId;

      const result = await withTenant(tenantId, async (tx) => {
        return await GatesService.getProjectGates(tx, tenantId, projectId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
`;

const routes = `import { Router } from 'express';
import { GatesController } from './gates.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';

export const gatesRouter = Router();

gatesRouter.use(authenticate);

gatesRouter.post('/:id/approve', requirePermissions(['project.manage']), GatesController.approve);
gatesRouter.post('/:id/reject', requirePermissions(['project.manage']), GatesController.reject);
gatesRouter.get('/project/:projectId', GatesController.listByProject);
`;

const baseDir = path.join(__dirname, 'src', 'modules', 'gates');
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

fs.writeFileSync(path.join(baseDir, 'gates.repository.ts'), repo);
fs.writeFileSync(path.join(baseDir, 'gates.service.ts'), service);
fs.writeFileSync(path.join(baseDir, 'gates.controller.ts'), controller);
fs.writeFileSync(path.join(baseDir, 'gates.routes.ts'), routes);

console.log("Gates generated.");
