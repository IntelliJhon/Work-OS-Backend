import { Router } from 'express';
import { ExpiryCronController } from './expiry-cron.controller';

const router = Router();

// Route for cron-job.org or manual triggers
// Accepts POST or GET requests authenticated by x-cron-secret header or secret query parameter
router.post('/check-subscription-expiries', ExpiryCronController.checkSubscriptionExpiries);
router.get('/check-subscription-expiries', ExpiryCronController.checkSubscriptionExpiries);

export default router;
