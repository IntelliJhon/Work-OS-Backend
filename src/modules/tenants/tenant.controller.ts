import { Request, Response, NextFunction } from 'express';
import { TenantService } from './tenant.service';

export class TenantController {
  static async createTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await TenantService.onboardTenant(req.body);
      return res.status(201).json(result);
    } catch (error: any) {
      if (error.message === 'Workspace slug is already taken') {
        return res.status(409).json({ error: error.message });
      }
      next(error);
    }
  }
}
