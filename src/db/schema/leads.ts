import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { uploads } from './uploads';
import { workspaceClients } from './workspace_clients';

// Leads (migration 0046): enquiries moved through stages on a board. Proposal files are uploads with
// entity_type 'LEAD'. No RLS: every query filters by tenant_id.

export const LEAD_STAGES = ['new', 'contacted', 'requirement', 'proposal', 'follow_up', 'accepted', 'rejected'] as const;
export type LeadStage = typeof LEAD_STAGES[number];
export const LEAD_SOURCES = ['manual', 'whatsapp', 'website', 'referral', 'call', 'walk_in', 'social', 'other'] as const;
export type LeadSource = typeof LEAD_SOURCES[number];
export const REJECT_REASONS = ['price', 'timing', 'competitor', 'no_response', 'not_needed', 'other'] as const;
export type RejectReason = typeof REJECT_REASONS[number];
export type LeadActivityKind = 'note' | 'created' | 'updated' | 'stage' | 'proposal' | 'whatsapp' | 'client' | 'archived' | 'restored';
export type AcceptedAs = 'bot' | 'client';

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  company: varchar('company', { length: 160 }),
  phone: varchar('phone', { length: 20 }).notNull(),
  email: varchar('email', { length: 255 }),
  city: varchar('city', { length: 80 }),
  source: varchar('source', { length: 20 }).$type<LeadSource>().default('manual').notNull(),
  service: varchar('service', { length: 120 }),
  expectedValue: numeric('expected_value', { precision: 12, scale: 2 }),
  stage: varchar('stage', { length: 20 }).$type<LeadStage>().default('new').notNull(),
  stageChangedAt: timestamp('stage_changed_at', { withTimezone: true }).defaultNow().notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
  notes: text('notes'),
  requirement: text('requirement'),
  budget: varchar('budget', { length: 80 }),
  timeline: varchar('timeline', { length: 80 }),
  rejectReason: varchar('reject_reason', { length: 20 }).$type<RejectReason>(),
  rejectNote: text('reject_note'),
  clientId: uuid('client_id').references(() => workspaceClients.id, { onDelete: 'set null' }),
  acceptedAs: varchar('accepted_as', { length: 10 }).$type<AcceptedAs>(),
  followUpRemindedFor: timestamp('follow_up_reminded_for', { withTimezone: true }),
  followUpOverdueFor: timestamp('follow_up_overdue_for', { withTimezone: true }),
  autoFollowUp: boolean('auto_follow_up').default(true).notNull(),
  autoFollowUpsSent: integer('auto_follow_ups_sent').default(0).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantStageIdx: index('idx_leads_tenant_stage').on(table.tenantId, table.stage),
  tenantPhoneIdx: index('idx_leads_tenant_phone').on(table.tenantId, table.phone),
}));

export const leadProposals = pgTable('lead_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }).notNull(),
  version: integer('version').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }),
  uploadId: uuid('upload_id').references(() => uploads.id, { onDelete: 'set null' }),
  note: text('note'),
  whatsappSentAt: timestamp('whatsapp_sent_at', { withTimezone: true }),
  whatsappError: text('whatsapp_error'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  leadIdx: index('idx_lead_proposals_lead').on(table.leadId, table.version),
}));

export const leadActivity = pgTable('lead_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }).notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  kind: varchar('kind', { length: 20 }).$type<LeadActivityKind>().notNull(),
  body: text('body'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  leadIdx: index('idx_lead_activity_lead').on(table.leadId, table.createdAt),
}));
