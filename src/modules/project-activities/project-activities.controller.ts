import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { ProjectActivitiesService } from './project-activities.service';

export class ProjectActivitiesController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { projectId, parentId, title, workHrs } = req.body;

      const result = await withTenant(tenantId, async (tx) => {
        return await ProjectActivitiesService.create(tx, tenantId, {
          projectId,
          parentId: parentId || null,
          title,
          workHrs: Number(workHrs || 0)
        });
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
        return await ProjectActivitiesService.listByProject(tx, tenantId, projectId);
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
      const { title, workHrs } = req.body;

      const result = await withTenant(tenantId, async (tx) => {
        return await ProjectActivitiesService.update(tx, tenantId, id, {
          title,
          workHrs: workHrs !== undefined ? Number(workHrs) : undefined,
        });
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

      const result = await withTenant(tenantId, async (tx) => {
        return await ProjectActivitiesService.delete(tx, tenantId, id);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
}
