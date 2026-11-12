import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { billingCustomers } from '../../db/schema/billing';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { zoho, zohoConfigured, zohoPdf } from '../../lib/zoho-books';
import { BillingError, BillingService } from './billing.service';

/**
 * GST invoices in Zoho Books, made from the Billing section: one or more lines at 18% GST, CGST + SGST inside our
 * state and IGST outside it (from the client's GSTIN), rounded to the rupee. Invoices are created as drafts; only
 * drafts can be deleted (a test invoice), sent invoices are cancelled with a credit note in Zoho.
 */

const CLIENT_ID = /^[a-f0-9]{24}$/i;
const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;
const SAC = /^\d{4,8}$/;
export const DEFAULT_SAC = '998314';
const GST_RATE = 18;

// GSTIN state code → Zoho Books place-of-supply code
const STATES: Record<string, string> = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR',
  '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH',
  '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ', '26': 'DN', '27': 'MH', '29': 'KA', '30': 'GA', '31': 'LD', '32': 'KL',
  '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AP', '38': 'LA',
};

const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

let taxCache: { intra: string; inter: string; at: number } | null = null;

/** The 18% GST tax group (CGST + SGST) and IGST 18% ids, looked up once an hour */
async function gstTaxes() {
  if (taxCache && Date.now() - taxCache.at < 3600_000) return taxCache;
  const { taxes } = await zoho<{ taxes: { tax_id: string; tax_name: string; tax_percentage: number; tax_type: string; tax_specific_type?: string }[] }>('GET', '/settings/taxes');
  const intra = taxes.find((t) => t.tax_type === 'tax_group' && Number(t.tax_percentage) === GST_RATE);
  const inter = taxes.find((t) => t.tax_type === 'tax' && t.tax_specific_type === 'igst' && Number(t.tax_percentage) === GST_RATE);
  if (!intra || !inter) throw new BillingError(503, 'GST 18% is not set up in Zoho Books (Settings → Taxes)');
  taxCache = { intra: intra.tax_id, inter: inter.tax_id, at: Date.now() };
  return taxCache;
}

export interface InvoiceLineInput { description: unknown; details?: unknown; sac?: unknown; amount: unknown }

export interface InvoiceInput {
  clientId: unknown;
  clientName: unknown;
  date?: unknown;
  gstin?: unknown;
  address?: unknown;
  city?: unknown;
  pin?: unknown;
  lines: unknown;
  notes?: unknown;
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');

export interface InvoiceSummary {
  id: string;
  number: string;
  clientName: string;
  date: string;
  total: number;
  status: string;
}

export class BillingInvoices {
  static async create(tenantId: string, input: InvoiceInput) {
    if (!zohoConfigured()) throw new BillingError(503, 'Zoho Books is not connected yet');
    const clientId = String(input.clientId ?? '');
    const clientName = text(input.clientName, 255);
    if (!CLIENT_ID.test(clientId) || !clientName) throw new BillingError(400, 'Choose the client');
    const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : todayIst();
    if (date > todayIst()) throw new BillingError(400, 'The invoice date cannot be in the future');

    const gstin = text(input.gstin, 15).toUpperCase();
    if (gstin && !GSTIN.test(gstin)) throw new BillingError(400, "The client's GSTIN has 15 letters and digits, e.g. 32ABCDE1234F1Z5");
    const state = gstin ? STATES[gstin.slice(0, 2)] : env.ZOHO_HOME_STATE;
    if (!state) throw new BillingError(400, "The GSTIN's state code is not recognised");

    if (!Array.isArray(input.lines) || !input.lines.length) throw new BillingError(400, 'Add at least one line');
    if (input.lines.length > 20) throw new BillingError(400, 'At most 20 lines');
    const lines = (input.lines as InvoiceLineInput[]).map((l, i) => {
      const description = text(l?.description, 200);
      if (!description) throw new BillingError(400, `Line ${i + 1}: enter what it is for`);
      const amount = round2(Number(l?.amount));
      if (!Number.isFinite(amount) || amount <= 0) throw new BillingError(400, `Line ${i + 1}: enter an amount above zero`);
      if (amount > 10_000_000) throw new BillingError(400, `Line ${i + 1}: the amount is too large`);
      const sac = text(l?.sac, 8) || DEFAULT_SAC;
      if (!SAC.test(sac)) throw new BillingError(400, `Line ${i + 1}: the SAC code is 4 to 8 digits`);
      return { description, details: text(l?.details, 500), sac, amount };
    });

    const customerId = await BillingService.zohoCustomer(tenantId, clientId, clientName);
    // Keep the client's GSTIN and billing address in Zoho (GST invoices to businesses must show them) and here
    const address = text(input.address, 300);
    const city = text(input.city, 80);
    const pin = text(input.pin, 10);
    if (gstin || address) {
      await zoho('PUT', `/contacts/${customerId}`, {
        ...(gstin ? { gst_no: gstin, gst_treatment: 'business_gst', place_of_contact: state } : {}),
        ...(address ? { billing_address: { address, city, zip: pin, country: 'India', state_code: state } } : {}),
      });
      if (gstin) {
        await db.update(billingCustomers).set({ gstin, updatedAt: new Date() })
          .where(and(eq(billingCustomers.tenantId, tenantId), eq(billingCustomers.clientId, clientId)));
      }
    }

    const taxes = await gstTaxes();
    const taxId = state === env.ZOHO_HOME_STATE ? taxes.intra : taxes.inter;
    const subTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const exact = round2(subTotal * (1 + GST_RATE / 100));
    const roundOff = round2(Math.round(exact) - exact);

    const created = await zoho<{ invoice: { invoice_id: string; invoice_number: string; total: number } }>('POST', '/invoices', {
      customer_id: customerId,
      date,
      ...(env.ZOHO_INVOICE_TEMPLATE_ID ? { template_id: env.ZOHO_INVOICE_TEMPLATE_ID } : {}),
      place_of_supply: state,
      gst_treatment: gstin ? 'business_gst' : 'business_none',
      ...(gstin ? { gst_no: gstin } : {}),
      ...(roundOff ? { adjustment: roundOff, adjustment_description: 'Round Off' } : {}),
      ...(text(input.notes, 500) ? { notes: text(input.notes, 500) } : {}),
      line_items: lines.map((l) => ({
        name: l.description, ...(l.details ? { description: l.details } : {}), hsn_or_sac: l.sac, quantity: 1, rate: l.amount, tax_id: taxId,
      })),
    });
    logger.info({ invoice: created.invoice.invoice_number, total: created.invoice.total }, '[Billing] Invoice created');
    return { id: created.invoice.invoice_id, number: created.invoice.invoice_number, total: created.invoice.total };
  }

  static async list(): Promise<InvoiceSummary[]> {
    if (!zohoConfigured()) return [];
    const { invoices } = await zoho<{ invoices: any[] }>('GET', '/invoices?per_page=100&sort_column=created_time&sort_order=D');
    return invoices.map((i) => ({
      id: String(i.invoice_id), number: String(i.invoice_number), clientName: String(i.customer_name),
      date: String(i.date), total: Number(i.total), status: String(i.status),
    }));
  }

  static async pdf(id: string) {
    if (!/^\d{5,25}$/.test(id)) throw new BillingError(400, 'Invalid invoice');
    return zohoPdf(`/invoices/${id}`);
  }

  /** Deletes a draft invoice (a test or a mistake); its number is not given out again unless the series is reset */
  static async remove(id: string) {
    if (!/^\d{5,25}$/.test(id)) throw new BillingError(400, 'Invalid invoice');
    const { invoice } = await zoho<{ invoice: { status: string; invoice_number: string } }>('GET', `/invoices/${id}`);
    if (invoice.status !== 'draft') throw new BillingError(409, 'Only draft invoices can be deleted. Cancel a sent invoice with a credit note in Zoho Books.');
    await zoho('DELETE', `/invoices/${id}`);
    logger.info({ invoice: invoice.invoice_number }, '[Billing] Draft invoice deleted');
    return { deleted: true, number: invoice.invoice_number };
  }
}
