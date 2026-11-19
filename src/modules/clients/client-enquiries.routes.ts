import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireLeadsndeals } from '../../middleware/company.middleware';
import { ClientEnquiriesController } from './client-enquiries.controller';

const router = Router();

// Part of Clients: LeadsNDeals workspace only
router.use(authenticate, requireLeadsndeals as any);

router.get('/', ClientEnquiriesController.list);
router.post('/', ClientEnquiriesController.create);
router.post('/import', ClientEnquiriesController.importBulk);
router.put('/:id', ClientEnquiriesController.update);
router.post('/:id/move-to-onboarding', ClientEnquiriesController.moveToOnboarding);
router.delete('/:id', ClientEnquiriesController.delete);

export default router;
