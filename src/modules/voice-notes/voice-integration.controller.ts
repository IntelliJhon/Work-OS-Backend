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
import type { IngestVoiceNoteBody } from './voice-notes.schema';

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

export class VoiceIntegrationController {
  /**
   * POST /api/integrations/voice-notes  (called by n8n)
   *
   * Responses n8n should branch on:
   *   201 { code: 'created' }               -> reply "Received" to the sender
   *   200 { code: 'duplicate' }             -> already stored (retry/duplicate webhook), do nothing
   *   404 { code: 'number_not_registered' } -> reply "This number isn't registered with Work OS"
   *   400 validation error / 401 bad secret / 503 not configured
   */
  static async ingest(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as IngestVoiceNoteBody;

      const phone = normalizePhone(body.senderPhone);
      if (!phone) {
        return res.status(400).json({ error: 'Invalid senderPhone', code: 'invalid_phone' });
      }

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

      if (!tenant) {
        logger.info({ phone: maskPhone(phone) }, '[VoiceIntegration] Voice note from unregistered number');
        return res.status(404).json({ error: 'This number is not registered with any workspace', code: 'number_not_registered' });
      }

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
          status,
        })
        .onConflictDoNothing({ target: voiceNotes.externalMessageId })
        .returning();

      if (!created) {
        return res.status(200).json({ success: true, code: 'duplicate', workspace: tenant.name });
      }

      emitToTenant(tenant.id, 'voice_note_new', created);
      logger.info({ tenantId: tenant.id, voiceNoteId: created.id, status }, '[VoiceIntegration] Voice note stored');

      return res.status(201).json({
        success: true,
        code: 'created',
        id: created.id,
        status,
        workspace: tenant.name,
      });
    } catch (err) {
      return next(err);
    }
  }
}
