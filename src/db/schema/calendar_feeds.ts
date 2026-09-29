import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

// A user's private calendar link. No RLS: looked up by token hash from a public URL (see migration 0033).
export const calendarFeeds = pgTable('calendar_feeds', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  tokenEncrypted: text('token_encrypted').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
