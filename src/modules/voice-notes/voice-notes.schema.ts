import { z } from 'zod';
import { VOICE_NOTE_STATUSES, VOICE_NOTE_KINDS } from '../../db/schema/voice_notes';

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

export const deleteVoiceNoteSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
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
    // Extracted by Gemini; empty string means "not mentioned"
    assigneeName: z.string().max(150).nullish(),
    taskTitle: z.string().max(255).nullish(),
    dueDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dueDate must be YYYY-MM-DD'), z.literal('')]).nullish(),
    dueTime: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'dueTime must be HH:mm'), z.literal('')]).nullish(),
    // Other people in the note and whether it is new work or an update (confirmation message and task)
    reviewerName: z.string().max(150).nullish(),
    informedNames: z.array(z.string().max(150)).max(20).nullish(),
    noteKind: z.enum(VOICE_NOTE_KINDS).nullish(),
    // 'whatsapp': Work OS sends the WhatsApp reply itself (n8n answers WAAU immediately)
    replyMode: z.enum(['whatsapp']).optional(),
  }),
});

export type IngestVoiceNoteBody = z.infer<typeof ingestVoiceNoteSchema>['body'];

export const assignVoiceNoteSchema = z.object({
  body: z.object({
    senderPhone: z.string().trim().min(8).max(25),
    // The owner's answer: an employee name, or the number of an offered choice
    reply: z.string().trim().min(1).max(200),
    replyMode: z.enum(['whatsapp']).optional(),
    // 'choice': a typed number; 'name': only a person's name; 'other': anything else (yes/no/cancel…)
    replyType: z.enum(['choice', 'name', 'other']).optional(),
    // true for chit-chat: stay silent when nothing is waiting for the sender
    quiet: z.boolean().optional(),
  }),
});

export type AssignVoiceNoteBody = z.infer<typeof assignVoiceNoteSchema>['body'];

export const voiceContextSchema = z.object({
  body: z.object({
    senderPhone: z.string().trim().min(8).max(25),
    // 'whatsapp': reply "not registered" to unknown senders (they are not sent to Gemini)
    replyMode: z.enum(['whatsapp']).optional(),
  }),
});
