import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth.middleware';
import { ClientsController } from './clients.controller';

export const clientsRouter = Router();

const storage = multer.memoryStorage();
const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit
    files: 10, // max 10 files per upload
  },
});

// --- Onboarded Clients (External API Proxy) ---
// GET /api/clients - Protected by Work OS JWT authentication
clientsRouter.get('/', authenticate as any, ClientsController.getClients as any);

// POST /api/clients/:id/comments - Add or update comment on an onboarded client
clientsRouter.post('/:id/comments', authenticate as any, ClientsController.saveClientComment as any);

// --- Client Documents Endpoints ---
// GET /api/clients/:id/documents - List documents for a client
clientsRouter.get('/:id/documents', authenticate as any, ClientsController.getClientDocuments as any);

// POST /api/clients/:id/documents - Add or upload multiple documents for a client
clientsRouter.post('/:id/documents', authenticate as any, uploadMiddleware.array('files', 10), ClientsController.addClientDocuments as any);

// GET /api/clients/:id/documents/:docId/view - View/stream document
clientsRouter.get('/:id/documents/:docId/view', ClientsController.viewClientDocument as any);

// GET /api/clients/:id/documents/:docId/download - Download document
clientsRouter.get('/:id/documents/:docId/download', ClientsController.downloadClientDocument as any);

// DELETE /api/clients/:id/documents/:docId - Delete a document
clientsRouter.delete('/:id/documents/:docId', authenticate as any, ClientsController.deleteClientDocument as any);

// --- Onboarding Clients Pipeline ---
// GET /api/clients/onboarding - List all onboarding clients for tenant
clientsRouter.get('/onboarding', authenticate as any, ClientsController.getOnboardingClients as any);

// POST /api/clients/onboarding - Manually create a new client in onboarding pipeline
clientsRouter.post('/onboarding', authenticate as any, ClientsController.createOnboardingClient as any);

// PATCH /api/clients/onboarding/:id - Update onboarding client details, stage, status
clientsRouter.patch('/onboarding/:id', authenticate as any, ClientsController.updateOnboardingClient as any);

// DELETE /api/clients/onboarding/:id - Delete onboarding client
clientsRouter.delete('/onboarding/:id', authenticate as any, ClientsController.deleteOnboardingClient as any);
