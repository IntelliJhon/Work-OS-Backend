import { integer, numeric, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

// Low conversation-wallet alerts (migration 0051)

/** The Partner Panel client accounts whose channels are watched */
export const lowBalanceWatch = pgTable('low_balance_watch', {
  userId: varchar('user_id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
});

/** When each low channel was last alerted */
export const lowBalanceAlerts = pgTable('low_balance_alerts', {
  channelId: varchar('channel_id', { length: 64 }).primaryKey(),
  userId: varchar('user_id', { length: 64 }),
  name: varchar('name', { length: 255 }).notNull(),
  number: varchar('number', { length: 32 }),
  balance: numeric('balance', { precision: 12, scale: 3 }).notNull(),
  alertCount: integer('alert_count').default(1).notNull(),
  alertedAt: timestamp('alerted_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Balance added from Work OS to a client's main or conversation wallet */
export const walletTopups = pgTable('wallet_topups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  clientId: varchar('client_id', { length: 64 }).notNull(),
  clientName: varchar('client_name', { length: 255 }),
  channelId: varchar('channel_id', { length: 64 }),
  channelNumber: varchar('channel_number', { length: 32 }),
  wallet: varchar('wallet', { length: 15 }).$type<'main' | 'conversation'>().notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  note: text('note'),
  status: varchar('status', { length: 10 }).$type<'done' | 'failed'>().notNull(),
  error: text('error'),
  source: varchar('source', { length: 10 }).$type<'button' | 'ai'>().default('button').notNull(),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
