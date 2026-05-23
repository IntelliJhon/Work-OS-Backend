import { Response, NextFunction } from 'express';
import { stories } from '../../db/schema/stories';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuditService } from '../../services/audit.service';
import { eq, and } from 'drizzle-orm';

export class StoriesController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        const [newStory] = await tx.insert(stories).values({
          tenantId,
          ...req.body,
        }).returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'INSERT',
          tableName: 'stories',
          recordId: newStory.id,
          newValue: newStory,
          ipAddress: req.ip,
        }, tx);

        return newStory;
      });

      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { epicId, projectId } = req.query;

      const result = await withTenant(tenantId, async (tx) => {
        let query = tx.select().from(stories).where(eq(stories.tenantId, tenantId));
        if (epicId && typeof epicId === 'string') {
          query = query.where(and(eq(stories.tenantId, tenantId), eq(stories.epicId, epicId)));
        }
        if (projectId && typeof projectId === 'string') {
          query = query.where(and(eq(stories.tenantId, tenantId), eq(stories.projectId, projectId)));
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
      const storyId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        const [oldStory] = await tx.select().from(stories).where(and(eq(stories.id, storyId), eq(stories.tenantId, tenantId)));
        
        if (!oldStory) {
          throw new Error('Story not found');
        }

        const [updatedStory] = await tx.update(stories)
          .set({ ...req.body, updatedAt: new Date() })
          .where(and(eq(stories.id, storyId), eq(stories.tenantId, tenantId)))
          .returning();

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'UPDATE',
          tableName: 'stories',
          recordId: updatedStory.id,
          oldValue: oldStory,
          newValue: updatedStory,
          ipAddress: req.ip,
        }, tx);

        return updatedStory;
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const storyId = req.params.id as string;

      await withTenant(tenantId, async (tx) => {
        const [oldStory] = await tx.select().from(stories).where(and(eq(stories.id, storyId), eq(stories.tenantId, tenantId)));
        
        if (!oldStory) {
          throw new Error('Story not found');
        }

        await tx.delete(stories).where(and(eq(stories.id, storyId), eq(stories.tenantId, tenantId)));

        await AuditService.logAction({
          tenantId,
          userId: req.user!.id,
          action: 'DELETE',
          tableName: 'stories',
          recordId: storyId,
          oldValue: oldStory,
          ipAddress: req.ip,
        }, tx);
      });

      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}
