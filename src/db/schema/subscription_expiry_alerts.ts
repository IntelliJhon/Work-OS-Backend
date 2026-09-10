import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const subscriptionExpiryAlerts = pgTable('subscription_expiry_alerts', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  clientId: text('client_id').notNull(),
  clientName: text('client_name'),
  clientEmail: text('client_email'),
  recipientNumber: text('recipient_number').notNull(),
  alertMilestone: text('alert_milestone').notNull(), // '7_DAYS_BEFORE', '3_DAYS_BEFORE', '1_DAY_BEFORE', 'EXPIRED'
  expiryDate: timestamp('expiry_date', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
});
