import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { ClientsController } from './clients.controller';

export const clientsRouter = Router();

// GET /api/clients - Protected by Work OS JWT authentication
clientsRouter.get('/', authenticate as any, ClientsController.getClients as any);

// POST /api/clients/:id/comments - Add or update comment on a client
clientsRouter.post('/:id/comments', authenticate as any, ClientsController.saveClientComment as any);

