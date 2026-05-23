const fs = require('fs');
const path = require('path');

const phasesRepo = `import { phases } from '../../db/schema/phases';
import { eq, and, asc } from 'drizzle-orm';

export class PhasesRepository {
  static async getPhaseById(tx: any, tenantId: string, phaseId: string) {
    const [phase] = await tx.select().from(phases).where(and(eq(phases.id, phaseId), eq(phases.tenantId, tenantId)));
    return phase;
  }

  static async getPhasesByProjectId(tx: any, tenantId: string, projectId: string) {
    return await tx.select().from(phases).where(and(eq(phases.projectId, projectId), eq(phases.tenantId, tenantId))).orderBy(asc(phases.orderIndex));
  }

  static async updatePhaseStatus(tx: any, tenantId: string, phaseId: string, status: 'pending' | 'active' | 'completed' | 'blocked', isLocked?: boolean) {
    const updateData: any = { status, updatedAt: new Date() };
    if (isLocked !== undefined) updateData.isLocked = isLocked;
    
    const [updatedPhase] = await tx.update(phases)
      .set(updateData)
      .where(and(eq(phases.id, phaseId), eq(phases.tenantId, tenantId)))
      .returning();
    return updatedPhase;
  }
}
`;

const phasesService = `import { PhasesRepository } from './phases.repository';
import { AuditService } from '../../services/audit.service';

export class PhasesService {
  static async activatePhase(tx: any, tenantId: string, userId: string, ipAddress: string, phaseId: string) {
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, phaseId);
    if (!phase) throw new Error('Phase not found');
    
    if (phase.status === 'completed') throw new Error('Cannot activate an already completed phase');
    if (phase.status === 'active') throw new Error('Phase is already active');
    if (phase.isLocked) throw new Error('Cannot activate a locked phase. Ensure previous phase is completed.');

    // Ensure no other phase is active
    const allPhases = await PhasesRepository.getPhasesByProjectId(tx, tenantId, phase.projectId);
    const activePhase = allPhases.find(p => p.status === 'active');
    if (activePhase) throw new Error('Another phase is currently active in this project');

    // Ensure sequence is followed
    const previousPhase = allPhases.find(p => p.orderIndex === phase.orderIndex - 1);
    if (previousPhase && previousPhase.status !== 'completed') {
      throw new Error('Previous phase must be completed before activating this phase');
    }

    const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'active');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: phaseId,
      oldValue: phase, newValue: updatedPhase, ipAddress,
    });

    return updatedPhase;
  }

  static async completePhase(tx: any, tenantId: string, userId: string, ipAddress: string, phaseId: string) {
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, phaseId);
    if (!phase) throw new Error('Phase not found');
    if (phase.status !== 'active') throw new Error('Only active phases can be completed');

    // Complete current phase
    const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'completed', true);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: phaseId,
      oldValue: phase, newValue: updatedPhase, ipAddress,
    });

    return updatedPhase;
  }

  static async blockPhase(tx: any, tenantId: string, userId: string, ipAddress: string, phaseId: string) {
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, phaseId);
    if (!phase) throw new Error('Phase not found');
    if (phase.status === 'completed') throw new Error('Cannot block a completed phase');

    const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'blocked');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: phaseId,
      oldValue: phase, newValue: updatedPhase, ipAddress,
    });

    return updatedPhase;
  }

  static async unlockNextPhase(tx: any, tenantId: string, projectId: string, currentOrderIndex: number) {
    const allPhases = await PhasesRepository.getPhasesByProjectId(tx, tenantId, projectId);
    const nextPhase = allPhases.find(p => p.orderIndex === currentOrderIndex + 1);
    
    if (nextPhase) {
      await PhasesRepository.updatePhaseStatus(tx, tenantId, nextPhase.id, 'pending', false);
    }
  }
}
`;

const phasesController = `import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { PhasesService } from './phases.service';

export class PhasesController {
  static async activate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const phaseId = req.params.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await PhasesService.activatePhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async complete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const phaseId = req.params.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await PhasesService.completePhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async block(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const phaseId = req.params.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await PhasesService.blockPhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
`;

const phasesRoutes = `import { Router } from 'express';
import { PhasesController } from './phases.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';

export const phasesRouter = Router();

phasesRouter.use(authenticate);

// We require project.manage for phase transitions
phasesRouter.post('/:id/activate', requirePermissions(['project.manage']), PhasesController.activate);
phasesRouter.post('/:id/complete', requirePermissions(['project.manage']), PhasesController.complete);
phasesRouter.post('/:id/block', requirePermissions(['project.manage']), PhasesController.block);
`;

const baseDir = path.join(__dirname, 'src', 'modules', 'phases');
fs.writeFileSync(path.join(baseDir, 'phases.repository.ts'), phasesRepo);
fs.writeFileSync(path.join(baseDir, 'phases.service.ts'), phasesService);
fs.writeFileSync(path.join(baseDir, 'phases.controller.ts'), phasesController);
fs.writeFileSync(path.join(baseDir, 'phases.routes.ts'), phasesRoutes);

console.log("Phases generated.");
