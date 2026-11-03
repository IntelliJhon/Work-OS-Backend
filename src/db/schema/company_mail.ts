import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { leads } from './leads';

// Company email per workspace (migration 0050). No RLS: every query filters by tenant_id.

export const tenantMailAccounts = pgTable('tenant_mail_accounts', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  fromEmail: varchar('from_email', { length: 255 }).notNull(),
  fromName: varchar('from_name', { length: 120 }),
  smtpHost: varchar('smtp_host', { length: 255 }).notNull(),
  smtpPort: integer('smtp_port').notNull(),
  smtpSecure: boolean('smtp_secure').default(true).notNull(),
  imapHost: varchar('imap_host', { length: 255 }),
  imapPort: integer('imap_port').default(993).notNull(),
  username: varchar('username', { length: 255 }).notNull(),
  passwordEncrypted: text('password_encrypted').notNull(),
  signature: text('signature'),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }),
  lastTestOk: boolean('last_test_ok'),
  lastTestError: text('last_test_error'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export interface EmailAttachment { name: string; uploadId?: string | null }

export const emails = pgTable('emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
  fromEmail: varchar('from_email', { length: 255 }).notNull(),
  to: text('to').array().notNull(),
  cc: text('cc').array().default([]).notNull(),
  subject: varchar('subject', { length: 300 }).notNull(),
  body: text('body').notNull(),
  attachments: jsonb('attachments').$type<EmailAttachment[]>().default([]).notNull(),
  status: varchar('status', { length: 10 }).$type<'sent' | 'failed'>().notNull(),
  error: text('error'),
  messageId: varchar('message_id', { length: 300 }),
  savedToSent: boolean('saved_to_sent').default(false).notNull(),
  via: varchar('via', { length: 10 }).$type<'manual' | 'ai'>().default('manual').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('idx_emails_tenant').on(table.tenantId, table.createdAt),
  leadIdx: index('idx_emails_lead').on(table.leadId),
}));
