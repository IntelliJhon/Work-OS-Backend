import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { billingCustomers, billingPayments, type PaymentMode } from '../../db/schema/billing';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { zoho, zohoConfigured, zohoPdf, ZohoError } from '../../lib/zoho-books';
import { normalizePhone, maskPhone } from '../../lib/phone';
import { fetchPartnerUsers } from '../clients/partner-channels';
import { UploadService } from '../uploads/upload.service';
import { WhatsAppService } from '../../services/whatsapp.service';
import { WhatsAppBotsService } from '../whatsapp-bots/whatsapp-bots.service';

/**
 * Billing section (LeadsNDeals): payments received from Onboarded Clients are recorded in Zoho Books as customer
 * payments, and the Zoho receipt PDF is sent to the client on WhatsApp once someone presses Send.
 */

export class BillingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const PAYMENT_MODES: Record<PaymentMode, string> = {
  upi: 'UPI', bank_transfer: 'Bank Transfer', cash: 'Cash', cheque: 'Cheque', other: 'Others',
};
// Zoho Books' own payment mode names
const ZOHO_MODE: Record<PaymentMode, string> = {
  upi: 'UPI', bank_transfer: 'Bank Transfer', cash: 'Cash', cheque: 'Check', other: 'Others',
};

export const MAX_PAYMENT = 10_000_000;
const CLIENT_ID = /^[a-f0-9]{24}$/i;
const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;

const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function needZoho() {
  if (!zohoConfigured()) throw new BillingError(503, 'Zoho Books is not connected yet');
}

export class BillingService {
  static status() {
    return { zohoConnected: zohoConfigured(), receiptTemplate: env.WHATSAPP_PAYMENT_RECEIPT_TEMPLATE, modes: PAYMENT_MODES };
  }

  /** Onboarded Clients (Partner Panel accounts) with their saved WhatsApp number, GSTIN and Zoho link */
  static async clients(tenantId: string) {
    const [partner, saved] = await Promise.all([
      fetchPartnerUsers(),
      db.select().from(billingCustomers).where(eq(billingCustomers.tenantId, tenantId)),
    ]);
    const byId = new Map(saved.map((s) => [s.clientId, s]));
    return partner
      .map((u) => {
        const s = byId.get(u.id);
        return { id: u.id, name: u.name, email: u.email, whatsapp: s?.whatsapp ?? null, gstin: s?.gstin ?? null, zohoLinked: Boolean(s?.zohoCustomerId) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Saves a client's WhatsApp number and GSTIN (both optional) */
  static async saveClient(tenantId: string, clientId: string, input: { name: string; whatsapp?: unknown; gstin?: unknown }) {
    if (!CLIENT_ID.test(clientId)) throw new BillingError(400, 'Invalid client');
    const whatsapp = input.whatsapp ? normalizePhone(input.whatsapp) : null;
    if (input.whatsapp && !whatsapp) throw new BillingError(400, 'Enter a valid WhatsApp number');
    const gstin = typeof input.gstin === 'string' && input.gstin.trim() ? input.gstin.trim().toUpperCase() : null;
    if (gstin && !GSTIN.test(gstin)) throw new BillingError(400, 'A GSTIN has 15 letters and digits, e.g. 32ABCDE1234F1Z5');
    const name = input.name.trim().slice(0, 255) || clientId;
    const [row] = await db.insert(billingCustomers).values({ tenantId, clientId, clientName: name, whatsapp, gstin })
      .onConflictDoUpdate({ target: [billingCustomers.tenantId, billingCustomers.clientId], set: { clientName: name, whatsapp, gstin, updatedAt: new Date() } })
      .returning();
    // Keep the GSTIN in Zoho Books too once the client is linked
    if (row.zohoCustomerId && gstin && zohoConfigured()) {
      await zoho('PUT', `/contacts/${row.zohoCustomerId}`, { gst_no: gstin, gst_treatment: 'business_gst' })
        .catch((err) => logger.warn({ clientId, error: err.message }, '[Billing] GSTIN not saved in Zoho'));
    }
    return { id: clientId, whatsapp: row.whatsapp, gstin: row.gstin };
  }

  /** The client's Zoho Books customer: saved link, else a customer with the same name, else a new one */
  static async zohoCustomer(tenantId: string, clientId: string, clientName: string): Promise<string> {
    const [saved] = await db.select().from(billingCustomers)
      .where(and(eq(billingCustomers.tenantId, tenantId), eq(billingCustomers.clientId, clientId))).limit(1);
    if (saved?.zohoCustomerId) return saved.zohoCustomerId;

    const found = await zoho<{ contacts: { contact_id: string; contact_name: string }[] }>(
      'GET', `/contacts?contact_type=customer&contact_name=${encodeURIComponent(clientName)}`);
    let zohoId = found.contacts.find((c) => c.contact_name.trim().toLowerCase() === clientName.trim().toLowerCase())?.contact_id;
    if (!zohoId) {
      const gstin = saved?.gstin;
      const created = await zoho<{ contact: { contact_id: string } }>('POST', '/contacts', {
        contact_name: clientName, contact_type: 'customer', ...(gstin ? { gst_no: gstin, gst_treatment: 'business_gst' } : {}),
      });
      zohoId = created.contact.contact_id;
      logger.info({ clientId, zohoId }, '[Billing] Created Zoho Books customer');
    }
    await db.insert(billingCustomers).values({ tenantId, clientId, clientName, zohoCustomerId: zohoId })
      .onConflictDoUpdate({ target: [billingCustomers.tenantId, billingCustomers.clientId], set: { zohoCustomerId: zohoId, clientName, updatedAt: new Date() } });
    return zohoId;
  }

  static async payments(tenantId: string) {
    return db.select().from(billingPayments).where(eq(billingPayments.tenantId, tenantId)).orderBy(desc(billingPayments.createdAt)).limit(300);
  }

  /** Records a payment in Zoho Books and keeps its receipt PDF; the receipt waits for Send */
  static async recordPayment(tenantId: string, userId: string, input: {
    clientId: unknown; clientName: unknown; amount: unknown; paidOn: unknown; mode: unknown; reference: unknown; note: unknown;
  }) {
    needZoho();
    const clientId = String(input.clientId ?? '');
    if (!CLIENT_ID.test(clientId)) throw new BillingError(400, 'Choose the client');
    const clientName = typeof input.clientName === 'string' && input.clientName.trim() ? input.clientName.trim().slice(0, 255) : '';
    if (!clientName) throw new BillingError(400, 'Choose the client');
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) throw new BillingError(400, 'Enter an amount above zero');
    if (amount > MAX_PAYMENT) throw new BillingError(400, 'That amount is too large');
    const paidOn = typeof input.paidOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) ? input.paidOn : todayIst();
    if (paidOn > todayIst()) throw new BillingError(400, 'The payment date cannot be in the future');
    const mode = String(input.mode) as PaymentMode;
    if (!(mode in PAYMENT_MODES)) throw new BillingError(400, 'Choose how the client paid');
    const reference = typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim().slice(0, 100) : null;
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : null;

    if (reference) {
      const [dup] = await db.select({ id: billingPayments.id }).from(billingPayments).where(and(
        eq(billingPayments.tenantId, tenantId), eq(billingPayments.clientId, clientId), eq(billingPayments.reference, reference),
      )).limit(1);
      if (dup) throw new BillingError(409, 'This reference number is already recorded for this client');
    }

    const customerId = await this.zohoCustomer(tenantId, clientId, clientName);
    const created = await zoho<{ payment: { payment_id: string; payment_number: string } }>('POST', '/customerpayments', {
      customer_id: customerId, payment_mode: ZOHO_MODE[mode], amount, date: paidOn,
      ...(reference ? { reference_number: reference } : {}), ...(note ? { description: note } : {}),
    });
    const [row] = await db.insert(billingPayments).values({
      tenantId, clientId, clientName, amount: amount.toFixed(2), paidOn, mode, reference, note,
      zohoPaymentId: created.payment.payment_id, zohoPaymentNumber: created.payment.payment_number, recordedBy: userId,
    }).returning();
    logger.info({ paymentId: row.id, zohoPaymentId: row.zohoPaymentId, amount }, '[Billing] Payment recorded');

    // The receipt PDF now, so Send is quick; if Zoho is slow it is fetched again on Send
    await this.receiptUpload(tenantId, userId, row).catch((err) => logger.warn({ paymentId: row.id, error: err.message }, '[Billing] Receipt PDF not saved yet'));
    const [fresh] = await db.select().from(billingPayments).where(eq(billingPayments.id, row.id));
    return fresh;
  }

  /** The receipt PDF from Zoho Books, stored once with the uploads */
  private static async receiptUpload(tenantId: string, userId: string, p: typeof billingPayments.$inferSelect): Promise<string> {
    if (p.receiptUploadId) return p.receiptUploadId;
    if (!p.zohoPaymentId) throw new BillingError(409, 'This payment is not in Zoho Books');
    const pdf = await zohoPdf(`/customerpayments/${p.zohoPaymentId}`);
    const name = `Receipt-${(p.zohoPaymentNumber || p.id).replace(/[^\w-]/g, '')}.pdf`;
    const up = await UploadService.processUpload({
      tenantId, uploaderId: userId, entityType: 'BILLING', entityId: p.id,
      file: { buffer: pdf, originalname: name, mimetype: 'application/pdf', size: pdf.length } as Express.Multer.File,
    });
    await db.update(billingPayments).set({ receiptUploadId: up.id }).where(eq(billingPayments.id, p.id));
    return up.id;
  }

  private static async payment(tenantId: string, id: string) {
    const [p] = await db.select().from(billingPayments).where(and(eq(billingPayments.id, id), eq(billingPayments.tenantId, tenantId))).limit(1);
    if (!p) throw new BillingError(404, 'Payment not found');
    return p;
  }

  /** A short-lived link to the receipt PDF */
  static async receiptUrl(tenantId: string, userId: string, id: string) {
    needZoho();
    const p = await this.payment(tenantId, id);
    const uploadId = await this.receiptUpload(tenantId, userId, p);
    return UploadService.getSignedDownloadUrl(tenantId, uploadId);
  }

  /** Sends the receipt to the client on WhatsApp and remembers the number for next time */
  static async sendReceipt(tenantId: string, userId: string, id: string, phoneInput: unknown) {
    needZoho();
    const p = await this.payment(tenantId, id);
    if (p.receiptStatus === 'sent') throw new BillingError(409, 'This receipt was already sent');
    const [saved] = await db.select().from(billingCustomers)
      .where(and(eq(billingCustomers.tenantId, tenantId), eq(billingCustomers.clientId, p.clientId))).limit(1);
    const phone = normalizePhone(phoneInput || saved?.whatsapp || '');
    if (!phone) throw new BillingError(400, "Enter the client's WhatsApp number");

    const uploadId = await this.receiptUpload(tenantId, userId, p);
    const url = await UploadService.getSignedDownloadUrl(tenantId, uploadId);
    const wa = await WhatsAppBotsService.forTenant(tenantId);
    const sent = await WhatsAppService.sendDocumentTemplate(phone, env.WHATSAPP_PAYMENT_RECEIPT_TEMPLATE, wa.templates.lang,
      { url, filename: `Receipt-${p.zohoPaymentNumber || 'payment'}.pdf` },
      [p.clientName, rupees(Number(p.amount)), longDate(p.paidOn), p.reference || PAYMENT_MODES[p.mode]], wa.sender);

    if (phone !== saved?.whatsapp) {
      await db.insert(billingCustomers).values({ tenantId, clientId: p.clientId, clientName: p.clientName, whatsapp: phone })
        .onConflictDoUpdate({ target: [billingCustomers.tenantId, billingCustomers.clientId], set: { whatsapp: phone, updatedAt: new Date() } });
    }
    const [row] = await db.update(billingPayments).set(sent.success
      ? { receiptStatus: 'sent', whatsappTo: phone, whatsappError: null, receiptSentAt: new Date(), sentBy: userId }
      : { receiptStatus: 'failed', whatsappTo: phone, whatsappError: sent.error ?? 'WhatsApp did not accept the message' },
    ).where(eq(billingPayments.id, p.id)).returning();
    if (!sent.success) logger.warn({ paymentId: p.id, to: maskPhone(phone), error: sent.error }, '[Billing] Receipt WhatsApp failed');
    return row;
  }

  /** No receipt for this payment (e.g. the client did not want one) */
  static async skipReceipt(tenantId: string, id: string) {
    const p = await this.payment(tenantId, id);
    if (p.receiptStatus === 'sent') throw new BillingError(409, 'This receipt was already sent');
    const [row] = await db.update(billingPayments).set({ receiptStatus: 'skipped' }).where(eq(billingPayments.id, p.id)).returning();
    return row;
  }
}

export { ZohoError };
