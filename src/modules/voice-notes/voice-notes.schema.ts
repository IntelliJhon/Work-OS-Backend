import { z } from 'zod';
import { VOICE_NOTE_STATUSES } from '../../db/schema/voice_notes';

// ---- Settings (Admin) ----
export const sendCodeSchema = z.object({
  body: z.object({
    phone: z.string().min(8).max(25),
  }),
});

export const verifyCodeSchema = z.object({
  body: z.object({
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  }),
});

// ---- Inbox ----
export const listVoiceNotesSchema = z.object({
  query: z.object({
    status: z.enum(VOICE_NOTE_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
});

export const updateVoiceNoteSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    status: z.enum(VOICE_NOTE_STATUSES).optional(),
    taskId: z.string().uuid().nullable().optional(),
  }).refine((b) => b.status !== undefined || b.taskId !== undefined, {
    message: 'Provide status or taskId',
  }),
});

// ---- Integration (n8n) ----
export const ingestVoiceNoteSchema = z.object({
  body: z.object({
    externalMessageId: z.string().trim().min(1).max(255),
    senderPhone: z.string().trim().min(8).max(25),
    audioUrl: z.string().url().max(2000).nullish(),
    originalTranscript: z.string().max(20000).nullish(),
    englishText: z.string().max(20000).optional(),
    detectedLanguage: z.string().max(50).nullish(),
    // Accept true/false or "true"/"false" (n8n expressions may stringify). Note: z.coerce.boolean() would turn "false" into true.
    unclear: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  }),
});

export type IngestVoiceNoteBody = z.infer<typeof ingestVoiceNoteSchema>['body'];
