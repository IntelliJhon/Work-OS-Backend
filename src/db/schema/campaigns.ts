import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

// Category campaigns (migration 0057): WhatsApp template sequences per category for Leads and Enquiry List contacts

export type EnrolmentKind = 'lead' | 'enquiry';
export type EnrolmentStatus = 'active' | 'paused' | 'stopped';
export type StopReason = 'replied' | 'interested' | 'demo' | 'not_interested' | 'opted_out' | 'converted' | 'lost' | 'removed' | 'manual' | 'finished';
/** Template body variables, filled from the contact */
export const CAMPAIGN_PARAMS = ['name', 'company', 'category', 'subcategory'] as const;
export type CampaignParam = typeof CAMPAIGN_PARAMS[number];

export const campaignSequences = pgTable('campaign_sequences', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  category: varchar('category', { length: 80 }).notNull(),
  active: boolean('active').default(false).notNull(),
  repeatEveryDays: integer('repeat_every_days').default(30),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const campaignSteps = pgTable('campaign_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  sequenceId: uuid('sequence_id').references(() => campaignSequences.id, { onDelete: 'cascade' }).notNull(),
  day: integer('day').notNull(),
  templateName: varchar('template_name', { length: 120 }).notNull(),
  language: varchar('language', { length: 10 }).default('en').notNull(),
  params: text('params').array().default([]).notNull(),
});

export const campaignEnrolments = pgTable('campaign_enrolments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  sequenceId: uuid('sequence_id').references(() => campaignSequences.id, { onDelete: 'cascade' }).notNull(),
  kind: varchar('kind', { length: 10 }).$type<EnrolmentKind>().notNull(),
  refId: uuid('ref_id').notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),
  name: varchar('name', { length: 160 }),
  company: varchar('company', { length: 160 }),
  category: varchar('category', { length: 80 }),
  subcategory: varchar('subcategory', { length: 80 }),
  status: varchar('status', { length: 10 }).$type<EnrolmentStatus>().default('active').notNull(),
  stopReason: varchar('stop_reason', { length: 20 }).$type<StopReason>(),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow().notNull(),
  stepsSent: integer('steps_sent').default(0).notNull(),
  nextSendAt: timestamp('next_send_at', { withTimezone: true }),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  lastError: text('last_error'),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
});

export const campaignMessages = pgTable('campaign_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  enrolmentId: uuid('enrolment_id').references(() => campaignEnrolments.id, { onDelete: 'cascade' }).notNull(),
  day: integer('day').notNull(),
  templateName: varchar('template_name', { length: 120 }).notNull(),
  kind: varchar('kind', { length: 10 }).$type<'sent' | 'failed' | 'reply'>().notNull(),
  text: text('text'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const campaignOptouts = pgTable('campaign_optouts', {
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),
  reason: varchar('reason', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.phone] }) }));
