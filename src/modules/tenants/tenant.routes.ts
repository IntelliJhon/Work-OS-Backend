import { Router } from 'express';
import { TenantController } from './tenant.controller';
import { validateRequest } from '../../middleware/validate.middleware';
import { createTenantSchema } from './tenant.schemas';

const router = Router();

router.post('/create', validateRequest(createTenantSchema), TenantController.createTenant);

export const tenantRouter = router;
