import { Router } from 'express';
import { ComplaintsController } from './complaints.controller';
import { authenticate } from '../../middleware/auth.middleware';

export const complaintsRouter = Router();

complaintsRouter.use(authenticate);

complaintsRouter.get('/', ComplaintsController.list);
complaintsRouter.post('/send-whatsapp-alert', ComplaintsController.sendWhatsAppAlert);
