import { z } from 'zod';
import { createTenantSchema } from './tenant.schemas';

export type CreateTenantDto = z.infer<typeof createTenantSchema>['body'];

export interface DefaultRoles {
  admin: string;
  pm: string;
  sm: string;
  dev: string;
  viewer: string;
}
