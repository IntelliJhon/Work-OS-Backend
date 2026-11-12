import { Router, type NextFunction, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../middleware/auth.middleware';
import { requireLeadsndeals } from '../../middleware/company.middleware';
import { logger } from '../../config/logger';
import { allows, roleAccess } from '../sections/role-access';
import { BillingError, BillingService, ZohoError } from './billing.service';
import { BillingInvoices } from './invoices';

/** Billing section (LeadsNDeals): Admins and roles with "Billing" (billing.manage) */
export const billingRouter = Router();

billingRouter.use(authenticate as any, requireLeadsndeals as any, (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (allows(await roleAccess(req.user!.tenantId, req.user!.roleId), 'billing.manage')) return next();
    return res.status(403).json({ error: 'Only Admins and people with Billing access can use this' });
  } catch (err) {
    return next(err);
  }
}) as any);

const handle = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) => (async (req: AuthRequest, res: Response) => {
  try {
    await fn(req, res);
  } catch (err: any) {
    if (err instanceof BillingError || err instanceof ZohoError) return res.status(err.status).json({ error: err.message });
    logger.error({ path: req.path, error: err.message }, '[Billing] Request failed');
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}) as any;

// GET /api/billing/status - Zoho Books connected? receipt template, payment modes
billingRouter.get('/status', handle(async (_req, res) => res.json(BillingService.status())));

// GET /api/billing/clients - Onboarded Clients with saved WhatsApp number and GSTIN
billingRouter.get('/clients', handle(async (req, res) => res.json({ clients: await BillingService.clients(req.user!.tenantId) })));

// PUT /api/billing/clients/:id - Save a client's WhatsApp number and GSTIN
billingRouter.put('/clients/:id', handle(async (req, res) => res.json(await BillingService.saveClient(
  req.user!.tenantId, String(req.params.id), { name: String(req.body?.name ?? ''), whatsapp: req.body?.whatsapp, gstin: req.body?.gstin },
))));

// GET /api/billing/payments - Payments received (newest first)
billingRouter.get('/payments', handle(async (req, res) => res.json({ payments: await BillingService.payments(req.user!.tenantId) })));

// POST /api/billing/payments - Record a payment in Zoho Books (receipt waits for Send)
billingRouter.post('/payments', handle(async (req, res) => res.status(201).json(await BillingService.recordPayment(req.user!.tenantId, req.user!.id, req.body ?? {}))));

// GET /api/billing/payments/:id/receipt - Link to the receipt PDF
billingRouter.get('/payments/:id/receipt', handle(async (req, res) => res.json({ url: await BillingService.receiptUrl(req.user!.tenantId, req.user!.id, String(req.params.id)) })));

// POST /api/billing/payments/:id/send-receipt - Send the receipt on WhatsApp
billingRouter.post('/payments/:id/send-receipt', handle(async (req, res) => res.json(await BillingService.sendReceipt(
  req.user!.tenantId, req.user!.id, String(req.params.id), req.body?.whatsapp,
))));

// GET /api/billing/invoices - Latest invoices in Zoho Books
billingRouter.get('/invoices', handle(async (_req, res) => res.json({ invoices: await BillingInvoices.list() })));

// POST /api/billing/invoices - Create a GST invoice (draft) in Zoho Books
billingRouter.post('/invoices', handle(async (req, res) => res.status(201).json(await BillingInvoices.create(req.user!.tenantId, req.body ?? {}))));

// GET /api/billing/invoices/:id/pdf - The invoice PDF
billingRouter.get('/invoices/:id/pdf', handle(async (req, res) => {
  const pdf = await BillingInvoices.pdf(String(req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="invoice.pdf"');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(pdf);
}));

// DELETE /api/billing/invoices/:id - Delete a draft invoice
billingRouter.delete('/invoices/:id', handle(async (req, res) => res.json(await BillingInvoices.remove(String(req.params.id)))));

// POST /api/billing/payments/:id/skip - No receipt for this payment
billingRouter.post('/payments/:id/skip', handle(async (req, res) => res.json(await BillingService.skipReceipt(req.user!.tenantId, String(req.params.id)))));
