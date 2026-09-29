import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

// Verified WhatsApp numbers that may send work to a workspace (see migration 0034). No RLS: looked up by phone.
export const tenantVoiceNumbers = pgTable('tenant_voice_numbers', {
  // Digits with country code, e.g. 919876543210. One workspace per number.
  phone: varchar('phone', { length: 20 }).primaryKey(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  // The member whose number it is: work sent from it is "from" this person
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
  verifiedAt: timestamp('verified_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('idx_tenant_voice_numbers_tenant_id').on(table.tenantId),
}));
