const fs = require('fs');
const path = require('path');

const repo = `import { sprints } from '../../db/schema/sprints';
import { tasks } from '../../db/schema/tasks';
import { phases } from '../../db/schema/phases';
import { eq, and } from 'drizzle-orm';

export class SprintsRepository {
  static async getSprintById(tx: any, tenantId: string, sprintId: string) {
    const [sprint] = await tx.select().from(sprints).where(and(eq(sprints.id, sprintId), eq(sprints.tenantId, tenantId)));
    return sprint;
  }

  static async getPhaseById(tx: any, tenantId: string, phaseId: string) {
    const [phase] = await tx.select().from(phases).where(and(eq(phases.id, phaseId), eq(phases.tenantId, tenantId)));
    return phase;
  }

  static async getActiveSprintsInPhase(tx: any, tenantId: string, phaseId: string) {
    return await tx.select().from(sprints).where(and(
      eq(sprints.phaseId, phaseId),
      eq(sprints.tenantId, tenantId),
      eq(sprints.status, 'active')
    ));
  }

  static async getIncompleteTasksForSprint(tx: any, tenantId: string, sprintId: string) {
    // Assuming status is 'done' or similar for tasks
    const allTasks = await tx.select().from(tasks).where(and(
      eq(tasks.sprintId, sprintId),
      eq(tasks.tenantId, tenantId)
    ));
    return allTasks.filter((t: any) => t.status !== 'done' && t.status !== 'completed');
  }

  static async updateSprintStatus(tx: any, tenantId: string, sprintId: string, status: 'planning' | 'active' | 'closed' | 'cancelled') {
    const [updatedSprint] = await tx.update(sprints)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(sprints.id, sprintId), eq(sprints.tenantId, tenantId)))
      .returning();
    return updatedSprint;
  }
}
`;

const service = `import { SprintsRepository } from './sprints.repository';
import { AuditService } from '../../services/audit.service';

export class SprintsService {
  static async startSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new Error('Sprint not found');
    if (sprint.status !== 'planning') throw new Error('Can only start sprints in planning state');

    const phase = await SprintsRepository.getPhaseById(tx, tenantId, sprint.phaseId);
    if (!phase) throw new Error('Parent phase not found');
    
    // Rule: sprint cannot start if parent phase is locked, pending, completed
    if (phase.status !== 'active') throw new Error('Cannot start sprint unless parent phase is active');
    if (phase.isLocked) throw new Error('Cannot start sprint in a locked phase');

    // Rule: no overlapping active sprint (default disabled)
    const activeSprints = await SprintsRepository.getActiveSprintsInPhase(tx, tenantId, sprint.phaseId);
    if (activeSprints.length > 0) throw new Error('Another sprint is already active in this phase');

    const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'active');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprintId,
      oldValue: sprint, newValue: updatedSprint, ipAddress,
    });

    return updatedSprint;
  }

  static async closeSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new Error('Sprint not found');
    if (sprint.status !== 'active') throw new Error('Can only close active sprints');

    // Validation: Enforce all sprint tasks completed before closure
    const incompleteTasks = await SprintsRepository.getIncompleteTasksForSprint(tx, tenantId, sprintId);
    if (incompleteTasks.length > 0) {
      throw new Error(\`Cannot close sprint. \${incompleteTasks.length} tasks remain incomplete.\`);
    }

    const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'closed');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprintId,
      oldValue: sprint, newValue: updatedSprint, ipAddress,
    });

    return updatedSprint;
  }

  static async cancelSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new Error('Sprint not found');

    const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'cancelled');

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprintId,
      oldValue: sprint, newValue: updatedSprint, ipAddress,
    });

    return updatedSprint;
  }
}
`;

const controller = `import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { SprintsService } from './sprints.service';

export class SprintsController {
  static async start(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const sprintId = req.params.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.startSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async close(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const sprintId = req.params.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.closeSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async cancel(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const sprintId = req.params.id;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.cancelSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
`;

const routes = `import { Router } from 'express';
import { SprintsController } from './sprints.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';

export const sprintsRouter = Router();

sprintsRouter.use(authenticate);

sprintsRouter.post('/:id/start', requirePermissions(['project.manage']), SprintsController.start);
sprintsRouter.post('/:id/close', requirePermissions(['project.manage']), SprintsController.close);
sprintsRouter.post('/:id/cancel', requirePermissions(['project.manage']), SprintsController.cancel);
`;

const baseDir = path.join(__dirname, 'src', 'modules', 'sprints');
fs.writeFileSync(path.join(baseDir, 'sprints.repository.ts'), repo);
fs.writeFileSync(path.join(baseDir, 'sprints.service.ts'), service);
fs.writeFileSync(path.join(baseDir, 'sprints.controller.ts'), controller);
fs.writeFileSync(path.join(baseDir, 'sprints.routes.ts'), routes);

console.log("Sprints generated.");
