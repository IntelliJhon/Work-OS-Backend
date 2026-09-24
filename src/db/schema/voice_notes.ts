import { pgTable, timestamp, uuid, varchar, text, index, jsonb } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { tasks } from './tasks';

// 'awaiting_assignee': the note has work in it but no (matching) employee yet; the owner is asked on WhatsApp.
export const VOICE_NOTE_STATUSES = ['new', 'converted', 'dismissed', 'unclear', 'awaiting_assignee'] as const;
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
  // Extracted by Gemini: the employee named in the note, a short work title and an optional due date/time
  assigneeName: varchar('assignee_name', { length: 150 }),
  taskTitle: varchar('task_title', { length: 255 }),
  dueDate: varchar('due_date', { length: 10 }), // YYYY-MM-DD
  dueTime: varchar('due_time', { length: 5 }), // HH:mm (24h)
  // Numbered choices last offered to the owner, so a reply of "2" can pick one
  assigneeCandidates: jsonb('assignee_candidates').$type<{ id: string; name: string }[]>(),
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
