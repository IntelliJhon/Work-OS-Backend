import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth.middleware';
import { requireLeadsndeals } from '../../middleware/company.middleware';
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

// Internal tool of the LeadsNDeals workspace only: every route needs a Work OS login from that workspace
clientsRouter.use(authenticate as any, requireLeadsndeals as any);

// --- Onboarded Clients (External API Proxy) ---
// GET /api/clients
clientsRouter.get('/', ClientsController.getClients as any);

// POST /api/clients/:id/comments - Add or update comment on an onboarded client
clientsRouter.post('/:id/comments', ClientsController.saveClientComment as any);

// --- Client Documents Endpoints ---
// GET /api/clients/:id/documents - List documents for a client
clientsRouter.get('/:id/documents', ClientsController.getClientDocuments as any);

// POST /api/clients/:id/documents - Add or upload multiple documents for a client
clientsRouter.post('/:id/documents', uploadMiddleware.array('files', 10), ClientsController.addClientDocuments as any);

// GET /api/clients/:id/documents/:docId/view - View/stream document
clientsRouter.get('/:id/documents/:docId/view', ClientsController.viewClientDocument as any);

// GET /api/clients/:id/documents/:docId/download - Download document
clientsRouter.get('/:id/documents/:docId/download', ClientsController.downloadClientDocument as any);

// DELETE /api/clients/:id/documents/:docId - Delete a document
clientsRouter.delete('/:id/documents/:docId', ClientsController.deleteClientDocument as any);

// --- Onboarding Clients Pipeline ---
// GET /api/clients/onboarding - List all onboarding clients for tenant
clientsRouter.get('/onboarding', ClientsController.getOnboardingClients as any);

// POST /api/clients/onboarding - Manually create a new client in onboarding pipeline
clientsRouter.post('/onboarding', ClientsController.createOnboardingClient as any);

// PATCH /api/clients/onboarding/:id - Update onboarding client details, stage, status
clientsRouter.patch('/onboarding/:id', ClientsController.updateOnboardingClient as any);

// DELETE /api/clients/onboarding/:id - Delete onboarding client
clientsRouter.delete('/onboarding/:id', ClientsController.deleteOnboardingClient as any);
