import { date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

// Company group chats (migration 0040). No RLS: every query filters by tenant_id and checks membership.

export interface ChatAttachment {
  uploadId: string;
  name: string;
  mimeType: string;
  size: number;
  // A voice message recorded in the chat (played inline), and its length
  voice?: boolean;
  durationMs?: number;
}

export const chatGroups = pgTable('chat_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  description: text('description'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index('idx_chat_groups_tenant').on(table.tenantId),
}));

export const chatGroupMembers = pgTable('chat_group_members', {
  groupId: uuid('group_id').references(() => chatGroups.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  // admin | member
  role: varchar('role', { length: 10 }).$type<'admin' | 'member'>().default('member').notNull(),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.groupId, table.userId] }),
  userIdx: index('idx_chat_group_members_user').on(table.tenantId, table.userId),
}));

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  groupId: uuid('group_id').references(() => chatGroups.id, { onDelete: 'cascade' }).notNull(),
  senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
  body: text('body'),
  mentions: uuid('mentions').array().default([]).notNull(),
  attachments: jsonb('attachments').$type<ChatAttachment[]>().default([]).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // Migration 0041: the message this one replies to, and pinning
  replyToId: uuid('reply_to_id').references((): AnyPgColumn => chatMessages.id, { onDelete: 'set null' }),
  pinnedAt: timestamp('pinned_at', { withTimezone: true }),
  pinnedBy: uuid('pinned_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  groupTimeIdx: index('idx_chat_messages_group_time').on(table.groupId, table.createdAt),
}));

export interface SummaryContent {
  keyPoints: string[];
  decisions: string[];
  actionItems: { text: string; person: string | null; personId: string | null; due: string | null }[];
  openQuestions: string[];
}

/** Saved AI summaries of a group for a range of local days (migration 0041) */
export const chatSummaries = pgTable('chat_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  groupId: uuid('group_id').references(() => chatGroups.id, { onDelete: 'cascade' }).notNull(),
  fromDay: date('from_day', { mode: 'string' }).notNull(),
  toDay: date('to_day', { mode: 'string' }).notNull(),
  content: jsonb('content').$type<SummaryContent>().notNull(),
  messageCount: integer('message_count').notNull(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  rangeUnique: unique('chat_summaries_group_range_unique').on(table.groupId, table.fromDay, table.toDay),
}));
