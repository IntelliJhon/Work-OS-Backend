import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { voiceNotes } from '../../db/schema/voice_notes';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { normalizePhone, maskPhone } from '../../lib/phone';
import { emitToTenant } from './voice-notes.controller';
import { VoiceAssignmentService, listMemberNames } from './voice-assignment.service';
import { sendReply, type ReplyContext } from './voice-replies';
import type { AssignVoiceNoteBody, IngestVoiceNoteBody } from './voice-notes.schema';

/** Constant-time secret comparison (hashing first makes lengths equal). */
const secretMatches = (provided: unknown, expected: string) => {
  if (typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

/** Header-only auth for machine-to-machine calls. Secrets are never accepted in query strings (they end up in logs). */
export const requireIntegrationSecret = (req: Request, res: Response, next: NextFunction) => {
  if (!env.VOICE_INTEGRATION_SECRET) {
    logger.error('[VoiceIntegration] VOICE_INTEGRATION_SECRET is not set; endpoint disabled');
    return res.status(503).json({ error: 'Integration disabled', code: 'not_configured' });
  }
  if (!secretMatches(req.headers['x-integration-secret'], env.VOICE_INTEGRATION_SECRET)) {
    logger.warn({ ip: req.ip }, '[VoiceIntegration] Rejected request with invalid secret');
    return res.status(401).json({ error: 'Unauthorized', code: 'invalid_secret' });
  }
  return next();
};

/** The workspace whose verified voice number this is, or null. */
async function findTenantByVoicePhone(phone: string) {
  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name, userId: tenants.voicePhoneUserId })
    .from(tenants)
    .where(
      and(
        eq(tenants.voicePhone, phone),
        isNotNull(tenants.voicePhoneVerifiedAt),
        eq(tenants.isActive, true),
        isNull(tenants.deletedAt),
      ),
    )
    .limit(1);
  return tenant ?? null;
}

/**
 * Sends the JSON response. With replyMode 'whatsapp' Work OS also sends the WhatsApp reply to the
 * sender itself (n8n has already answered WAAU, which does not wait long enough for transcription).
 */
async function respond(
  res: Response,
  status: number,
  payload: { code: string; workspace?: string } & Record<string, unknown>,
  replyTo: string | null,
) {
  let replySent = false;
  if (replyTo) {
    replySent = await sendReply(replyTo, payload as unknown as ReplyContext, payload.workspace);
  }
  return res.status(status).json({ ...payload, ...(replyTo ? { replySent } : {}) });
}

const notRegistered = (res: Response, phone: string, replyTo: string | null) => {
  logger.info({ phone: maskPhone(phone) }, '[VoiceIntegration] Message from unregistered number');
  return respond(res, 404, { error: 'This number is not registered with any workspace', code: 'number_not_registered' }, replyTo);
};

export class VoiceIntegrationController {
  /**
   * POST /api/integrations/voice-notes  (called by n8n)
   *
   * Responses n8n should branch on (201 bodies also carry the assignment outcome fields):
   *   201 { code: 'task_created', workId, assigneeName, ownerNotified, employeeNotified, employeeHasPhone }
   *   201 { code: 'assignee_required' }                          -> ask the owner who should do it
   *   201 { code: 'assignee_not_found' | 'assignee_ambiguous', heardName, choices[] } -> ask to pick
   *   201 { code: 'created', status: 'unclear' }                 -> stored for review, no task
   *   200 { code: 'duplicate' }             -> already stored (retry/duplicate webhook), do nothing
   *   404 { code: 'number_not_registered' } -> reply "This number isn't registered with Work OS"
   *   400 validation error / 401 bad secret / 503 not configured
   */
  static async ingest(req: Request, res: Response, next: NextFunction) {
    let replyTo: string | null = null;
    try {
      const body = req.body as IngestVoiceNoteBody;

      const phone = normalizePhone(body.senderPhone);
      if (!phone) {
        return res.status(400).json({ error: 'Invalid senderPhone', code: 'invalid_phone' });
      }
      replyTo = body.replyMode === 'whatsapp' ? phone : null;

      const tenant = await findTenantByVoicePhone(phone);
      if (!tenant) return notRegistered(res, phone, replyTo);

      const englishText = (body.englishText || '').trim();
      const flaggedUnclear = body.unclear === true || body.unclear === 'true';
      const status = flaggedUnclear || !englishText ? 'unclear' : 'new';

      const [created] = await db
        .insert(voiceNotes)
        .values({
          tenantId: tenant.id,
          senderUserId: tenant.userId,
          senderPhone: phone,
          externalMessageId: body.externalMessageId,
          audioUrl: body.audioUrl ?? null,
          originalTranscript: body.originalTranscript?.trim() || null,
          englishText,
          detectedLanguage: body.detectedLanguage?.trim() || null,
          assigneeName: body.assigneeName?.trim() || null,
          taskTitle: body.taskTitle?.trim() || null,
          dueDate: body.dueDate || null,
          dueTime: body.dueDate ? body.dueTime || null : null,
          reviewerName: body.reviewerName?.trim() || null,
          informedNames: (body.informedNames || []).map((n) => n.trim()).filter(Boolean).slice(0, 10),
          noteKind: body.noteKind || null,
          status,
        })
        .onConflictDoNothing({ target: voiceNotes.externalMessageId })
        .returning();

      if (!created) {
        return respond(res, 200, { success: true, code: 'duplicate', workspace: tenant.name }, replyTo);
      }

      // Signal only; clients refetch through the permission-checked API
      emitToTenant(tenant.id, 'voice_note_new', { id: created.id, status: created.status });
      logger.info({ tenantId: tenant.id, voiceNoteId: created.id, status }, '[VoiceIntegration] Voice note stored');

      const base = { success: true, id: created.id, workspace: tenant.name };
      if (status === 'unclear') {
        return respond(res, 201, { ...base, code: 'created', status }, replyTo);
      }

      // The note is stored either way; if assignment fails it stays in the inbox as 'new'
      try {
        const outcome = await VoiceAssignmentService.proposeNewNote(created);
        return respond(res, 201, { ...base, ...outcome }, replyTo);
      } catch (err) {
        logger.error({ err, voiceNoteId: created.id }, '[VoiceIntegration] Auto-assignment failed; note left in inbox');
        return respond(res, 201, { ...base, code: 'created', status }, replyTo);
      }
    } catch (err) {
      if (replyTo) await sendReply(replyTo, { code: 'error' });
      return next(err);
    }
  }

  /**
   * POST /api/integrations/voice-notes/assign  (called by n8n)
   * The owner's answer to "who should do this?": a name, or the number of an offered choice.
   * 200 bodies carry the same assignment codes as ingest, plus 'no_pending_note'.
   */
  static async assign(req: Request, res: Response, next: NextFunction) {
    let replyTo: string | null = null;
    try {
      const body = req.body as AssignVoiceNoteBody;
      const phone = normalizePhone(body.senderPhone);
      if (!phone) {
        return res.status(400).json({ error: 'Invalid senderPhone', code: 'invalid_phone' });
      }
      replyTo = body.replyMode === 'whatsapp' ? phone : null;

      const tenant = await findTenantByVoicePhone(phone);
      if (!tenant) return notRegistered(res, phone, replyTo);

      const outcome = await VoiceAssignmentService.handleReply(tenant.id, body.reply, body.replyType, body.quiet === true);
      return respond(res, 200, { success: true, workspace: tenant.name, ...outcome }, replyTo);
    } catch (err) {
      if (replyTo) await sendReply(replyTo, { code: 'error' });
      return next(err);
    }
  }

  /**
   * POST /api/integrations/voice-notes/context  (called by n8n before Gemini)
   * The sender's workspace and its member names, so Gemini writes spoken names the way they are
   * stored in Work OS. 404 number_not_registered lets n8n stop early (no Gemini call).
   */
  static async context(req: Request, res: Response, next: NextFunction) {
    try {
      const phone = normalizePhone(req.body?.senderPhone);
      if (!phone) {
        return res.status(400).json({ error: 'Invalid senderPhone', code: 'invalid_phone' });
      }
      const tenant = await findTenantByVoicePhone(phone);
      if (!tenant) return notRegistered(res, phone, req.body?.replyMode === 'whatsapp' ? phone : null);

      return res.json({ success: true, code: 'registered', workspace: tenant.name, members: await listMemberNames(tenant.id) });
    } catch (err) {
      return next(err);
    }
  }
}
