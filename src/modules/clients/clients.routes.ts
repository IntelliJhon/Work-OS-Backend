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

// GET /api/clients/wallet-topups - Recharge history (top-ups made from Work OS)
clientsRouter.get('/wallet-topups', ClientsController.getWalletTopups as any);

// POST /api/clients/:id/wallet-topup - Add balance to the main or a conversation wallet (Admins only)
clientsRouter.post('/:id/wallet-topup', ClientsController.topUpWallet as any);

// WAAU automation tasks: read now (Admins), add tasks via the TASK add-on (Admins), daily check + alert on/off
clientsRouter.post('/:id/tasks/refresh', ClientsController.refreshTasks as any);
clientsRouter.post('/:id/tasks/add', ClientsController.addTasks as any);
clientsRouter.put('/:id/task-alert', ClientsController.setTaskAlert as any);

// PUT /api/clients/:id/low-balance-alert - Low conversation-balance WhatsApp alert on/off for a client
clientsRouter.put('/:id/low-balance-alert', ClientsController.setLowBalanceAlert as any);

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
