import { Response, NextFunction } from 'express';
import { epics } from '../../db/schema/epics';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { eq, and } from 'drizzle-orm';

export class EpicsController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        const [newEpic] = await tx.insert(epics).values({
          tenantId,
          ...req.body,
        }).returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'INSERT',
          tableName: 'epics',
          recordId: newEpic.id,
          newValue: newEpic,
          ipAddress: req.ip,
        }, tx);

        return newEpic;
      });

      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { projectId } = req.query;

      const result = await withTenant(tenantId, async (tx) => {
        let query = tx.select().from(epics).where(eq(epics.tenantId, tenantId));
        if (projectId && typeof projectId === 'string') {
          query = query.where(and(eq(epics.tenantId, tenantId), eq(epics.projectId, projectId)));
        }
        return await query;
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const epicId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        const [oldEpic] = await tx.select().from(epics).where(and(eq(epics.id, epicId), eq(epics.tenantId, tenantId)));
        
        if (!oldEpic) {
          throw new Error('Epic not found');
        }

        const [updatedEpic] = await tx.update(epics)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(epics.id, epicId), eq(epics.tenantId, tenantId)))
          .returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'UPDATE',
          tableName: 'epics',
          recordId: updatedEpic.id,
          oldValue: oldEpic,
          newValue: updatedEpic,
          ipAddress: req.ip,
        }, tx);

        return updatedEpic;
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const epicId = req.params.id as string;

      await withTenant(tenantId, async (tx) => {
        const [oldEpic] = await tx.select().from(epics).where(and(eq(epics.id, epicId), eq(epics.tenantId, tenantId)));
        
        if (!oldEpic) {
          throw new Error('Epic not found');
        }

        await tx.delete(epics).where(and(eq(epics.id, epicId), eq(epics.tenantId, tenantId)));

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'DELETE',
          tableName: 'epics',
          recordId: epicId,
          oldValue: oldEpic,
          ipAddress: req.ip,
        }, tx);
      });

      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}
