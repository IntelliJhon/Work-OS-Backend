import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { withTenant } from '../../middleware/tenant.middleware';
import { ProjectsService } from './projects.service';
import { projectMembers } from '../../db/schema/project_members';
import { tasks } from '../../db/schema/tasks';
import { eq, and } from 'drizzle-orm';


export class ProjectsController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        return await ProjectsService.initializeProject(tx, tenantId, req.user!.id, req.ip || '', req.body);
      });

      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      const result = await withTenant(tenantId, async (tx) => {
        return await ProjectsService.getProjects(tx, tenantId, req.user!.id, req.user!.permissions);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.id as string;
      const permissions = req.user!.permissions;

      const result = await withTenant(tenantId, async (tx) => {
        // Enforce membership check
        if (permissions['admin'] !== true && permissions['project.manage'] !== true) {
          const [member] = await tx
            .select()
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.tenantId, tenantId),
                eq(projectMembers.projectId, projectId),
                eq(projectMembers.userId, req.user!.id)
              )
            );
          if (!member) {
            // Check if user is assigned to any task in this project
            const [assignedTask] = await tx
              .select({ id: tasks.id })
              .from(tasks)
              .where(
                and(
                  eq(tasks.tenantId, tenantId),
                  eq(tasks.projectId, projectId),
                  eq(tasks.assigneeId, req.user!.id)
                )
              )
              .limit(1);

            if (!assignedTask) {
              throw new Error('Forbidden: You are not a member of this project');
            }
          }
        }
        return await ProjectsService.getProjectDetail(tx, tenantId, projectId);
      });

      if (!result) {
        return res.status(404).json({ error: 'Project not found' });
      }

      return res.json(result);
    } catch (error: any) {
      if (error.message && error.message.includes('Forbidden')) {
        return res.status(403).json({ error: error.message });
      }
      next(error);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await ProjectsService.updateProject(tx, tenantId, req.user!.id, req.ip || '', projectId, req.body);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const projectId = req.params.id as string;

      await withTenant(tenantId, async (tx) => {
        await ProjectsService.deleteProject(tx, tenantId, req.user!.id, req.ip || '', projectId);
      });

      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}
