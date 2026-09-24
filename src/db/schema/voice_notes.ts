import { pgTable, timestamp, uuid, varchar, text, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { tasks } from './tasks';

export const VOICE_NOTE_STATUSES = ['new', 'converted', 'dismissed', 'unclear'] as const;
export type VoiceNoteStatus = (typeof VOICE_NOTE_STATUSES)[number];

export const voiceNotes = pgTable('voice_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
  senderPhone: varchar('sender_phone', { length: 20 }).notNull(),
  // WAAU message ID. Globally unique: a retried or duplicated webhook can never create a second row.
  externalMessageId: varchar('external_message_id', { length: 255 }).notNull().unique(),
  audioUrl: text('audio_url'),
  originalTranscript: text('original_transcript'),
  englishText: text('english_text').notNull(),
  detectedLanguage: varchar('detected_language', { length: 50 }),
  status: varchar('status', { length: 20 }).$type<VoiceNoteStatus>().default('new').notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantCreatedIdx: index('idx_voice_notes_tenant_created').on(table.tenantId, table.createdAt),
  tenantStatusIdx: index('idx_voice_notes_tenant_status').on(table.tenantId, table.status),
}));
