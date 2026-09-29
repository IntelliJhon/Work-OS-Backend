import { Router } from 'express';
import { ComplaintsController } from './complaints.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireLeadsndeals } from '../../middleware/company.middleware';

export const complaintsRouter = Router();

// Internal tool of the LeadsNDeals workspace only
complaintsRouter.use(authenticate, requireLeadsndeals as any);

complaintsRouter.get('/', ComplaintsController.list);
complaintsRouter.post('/send-whatsapp-alert', ComplaintsController.sendWhatsAppAlert);
