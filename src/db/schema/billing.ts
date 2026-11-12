import { date, numeric, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

// Billing section (migration 0053)

/** An Onboarded Client (Partner Panel account) linked to its Zoho Books customer */
export const billingCustomers = pgTable('billing_customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  clientId: varchar('client_id', { length: 64 }).notNull(),
  clientName: varchar('client_name', { length: 255 }).notNull(),
  zohoCustomerId: varchar('zoho_customer_id', { length: 32 }),
  whatsapp: varchar('whatsapp', { length: 20 }),
  gstin: varchar('gstin', { length: 15 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PaymentMode = 'upi' | 'bank_transfer' | 'cash' | 'cheque' | 'other';
export type ReceiptStatus = 'pending' | 'sent' | 'failed' | 'skipped';

/** A payment received from a client, recorded in Zoho Books, and its receipt */
export const billingPayments = pgTable('billing_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  clientId: varchar('client_id', { length: 64 }).notNull(),
  clientName: varchar('client_name', { length: 255 }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  paidOn: date('paid_on').notNull(),
  mode: varchar('mode', { length: 20 }).$type<PaymentMode>().notNull(),
  reference: varchar('reference', { length: 100 }),
  note: text('note'),
  zohoPaymentId: varchar('zoho_payment_id', { length: 32 }),
  zohoPaymentNumber: varchar('zoho_payment_number', { length: 50 }),
  receiptUploadId: uuid('receipt_upload_id'),
  receiptStatus: varchar('receipt_status', { length: 10 }).$type<ReceiptStatus>().default('pending').notNull(),
  whatsappTo: varchar('whatsapp_to', { length: 20 }),
  whatsappError: text('whatsapp_error'),
  receiptSentAt: timestamp('receipt_sent_at', { withTimezone: true }),
  recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
  sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
