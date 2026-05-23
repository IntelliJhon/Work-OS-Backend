import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { withTenant } from '../../middleware/tenant.middleware';
import { TenantRepository } from '../tenants/tenant.repository';
import { AuthRepository } from './auth.repository';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export class AuthController {
  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { workspace, email, password } = req.body;

      // 1. Lookup tenant globally using slug (workspace)
      const tenant = await TenantRepository.findBySlug(workspace);
      if (!tenant || !tenant.isActive) {
        return res.status(401).json({ error: 'Invalid workspace or credentials' });
      }

      // 2. Open strictly enforced tenant context
      const result = await withTenant(tenant.id, async (tx) => {
        return await AuthService.login(tx, email, password);
      });

      return res.json(result);
    } catch (error: any) {
      if (error.message === 'Invalid credentials') {
        return res.status(401).json({ error: 'Invalid workspace or credentials' });
      }
      next(error);
    }
  }

  static async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      
      let decoded: any;
      try {
        decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
      } catch (err) {
        return res.status(401).json({ error: 'Refresh token invalid or expired' });
      }

      const { tenantId } = decoded;

      const result = await withTenant(tenantId, async (tx) => {
        return await AuthService.verifyAndRotateRefreshToken(tx, refreshToken, decoded);
      });

      return res.json(result);
    } catch (error: any) {
      return res.status(401).json({ error: 'Refresh token invalid or expired' });
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      const user = (req as any).user;

      await withTenant(user.tenantId, async (tx) => {
        await AuthService.logout(tx, user.id, refreshToken);
      });

      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  static async me(req: Request, res: Response, next: NextFunction) {
    try {
      const userPayload = (req as any).user;
      if (!userPayload) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const result = await withTenant(userPayload.tenantId, async (tx) => {
        const u = await AuthRepository.findUserById(tx, userPayload.id);
        if (!u) return null;
        const role = await AuthRepository.getRoleById(tx, u.roleId);
        return {
          id: u.id,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          tenantId: u.tenantId,
          role: role.name,
          permissions: role.permissions,
        };
      });

      if (!result) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json({ user: result });
    } catch (error) {
      next(error);
    }
  }
}
