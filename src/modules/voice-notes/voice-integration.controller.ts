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

type Payload = { code: string; workspace?: string } & Record<string, unknown>;
type Result = { status: number; payload: Payload };

/**
 * Runs the work and answers the request. With replyMode 'whatsapp' (replyTo set), n8n is answered
 * immediately with 202 and Work OS sends the WhatsApp reply itself once the work is done: creating a
 * task and sending templates can take longer than n8n waits, and a timed-out request would be retried.
 */
async function run(res: Response, next: NextFunction, replyTo: string | null, work: () => Promise<Result>) {
  if (!replyTo) {
    try {
      const { status, payload } = await work();
      return res.status(status).json(payload);
    } catch (err) {
      return next(err);
    }
  }

  res.status(202).json({ success: true, code: 'accepted' });
  try {
    const { payload } = await work();
    await sendReply(replyTo, payload as unknown as ReplyContext, payload.workspace);
  } catch (err) {
    logger.error({ err, to: maskPhone(replyTo) }, '[VoiceIntegration] Processing failed after accepting the request');
    await sendReply(replyTo, { code: 'error' });
  }
}

const notRegistered = (phone: string): Result => {
  logger.info({ phone: maskPhone(phone) }, '[VoiceIntegration] Message from unregistered number');
  return { status: 404, payload: { error: 'This number is not registered with any workspace', code: 'number_not_registered' } };
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
    const body = req.body as IngestVoiceNoteBody;
    const phone = normalizePhone(body.senderPhone);
    if (!phone) {
      return res.status(400).json({ error: 'Invalid senderPhone', code: 'invalid_phone' });
    }
    return run(res, next, body.replyMode === 'whatsapp' ? phone : null, () => VoiceIntegrationController.processIngest(body, phone));
  }

  private static async processIngest(body: IngestVoiceNoteBody, phone: string): Promise<Result> {
    const tenant = await findTenantByVoicePhone(phone);
    if (!tenant) return notRegistered(phone);

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
      return { status: 200, payload: { success: true, code: 'duplicate', workspace: tenant.name } };
    }

    // Signal only; clients refetch through the permission-checked API
    emitToTenant(tenant.id, 'voice_note_new', { id: created.id, status: created.status });
    logger.info({ tenantId: tenant.id, voiceNoteId: created.id, status }, '[VoiceIntegration] Voice note stored');

    const base = { success: true, id: created.id, workspace: tenant.name };
    if (status === 'unclear') {
      return { status: 201, payload: { ...base, code: 'created', status } };
    }

    // The note is stored either way; if proposing fails it stays in the inbox as 'new'
    try {
      const outcome = await VoiceAssignmentService.proposeNewNote(created);
      return { status: 201, payload: { ...base, ...outcome } };
    } catch (err) {
      logger.error({ err, voiceNoteId: created.id }, '[VoiceIntegration] Proposing the note failed; note left in inbox');
      return { status: 201, payload: { ...base, code: 'created', status } };
    }
  }

  /**
   * POST /api/integrations/voice-notes/assign  (called by n8n)
   * The owner's answer to "who should do this?": a name, or the number of an offered choice.
   * 200 bodies carry the same assignment codes as ingest, plus 'no_pending_note'.
   */
  static async assign(req: Request, res: Response, next: NextFunction) {
    const body = req.body as AssignVoiceNoteBody;
    const phone = normalizePhone(body.senderPhone);
    if (!phone) {
      return res.status(400).json({ error: 'Invalid senderPhone', code: 'invalid_phone' });
    }
    return run(res, next, body.replyMode === 'whatsapp' ? phone : null, async () => {
      const tenant = await findTenantByVoicePhone(phone);
      if (!tenant) return notRegistered(phone);
      const outcome = await VoiceAssignmentService.handleReply(tenant.id, body.reply, body.replyType, body.quiet === true);
      return { status: 200, payload: { success: true, workspace: tenant.name, ...outcome } };
    });
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
      if (!tenant) {
        const { status, payload } = notRegistered(phone);
        res.status(status).json(payload);
        // Reply after answering, so a slow WhatsApp send never delays n8n (rate-limited per number)
        if (req.body?.replyMode === 'whatsapp') await sendReply(phone, payload as unknown as ReplyContext);
        return;
      }

      return res.json({ success: true, code: 'registered', workspace: tenant.name, members: await listMemberNames(tenant.id) });
    } catch (err) {
      return next(err);
    }
  }
}
