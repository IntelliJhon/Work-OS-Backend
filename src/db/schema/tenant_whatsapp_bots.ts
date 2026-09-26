import { pgTable, timestamp, uuid, varchar, text } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

/** A workspace's own WhatsApp bot (WAAU channel). Managed by platform admins; see migration 0032. */
export const tenantWhatsappBots = pgTable('tenant_whatsapp_bots', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  // Channel phone number ID; also the bot ID n8n passes as ?bot=
  phoneNumberId: varchar('phone_number_id', { length: 64 }).notNull().unique(),
  // AES-256-GCM, see lib/crypto
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  businessPhone: varchar('business_phone', { length: 20 }),
  otpTemplate: varchar('otp_template', { length: 100 }),
  ownerTemplate: varchar('owner_template', { length: 100 }),
  employeeTemplate: varchar('employee_template', { length: 100 }),
  templateLang: varchar('template_lang', { length: 10 }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
