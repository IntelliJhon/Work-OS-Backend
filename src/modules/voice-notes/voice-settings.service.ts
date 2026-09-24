import crypto from 'crypto';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { normalizePhone, maskPhone } from '../../lib/phone';
import { WhatsAppService } from '../../services/whatsapp.service';
import { logger } from '../../config/logger';

const OTP_TTL_MS = 10 * 60 * 1000;      // code valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;   // one code per minute
const MAX_ATTEMPTS = 5;                 // wrong guesses before a new code is required

export class VoiceSettingsError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const hashCode = (tenantId: string, phone: string, code: string) =>
  crypto.createHash('sha256').update(`${tenantId}:${phone}:${code}`).digest('hex');

const safeEqualHex = (a: string, b: string) => {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

async function loadTenant(tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new VoiceSettingsError(404, 'tenant_not_found', 'Workspace not found');
  return tenant;
}

export class VoiceSettingsService {
  static async getSettings(tenantId: string) {
    const t = await loadTenant(tenantId);
    const now = Date.now();
    const pendingActive = !!t.voicePhonePending && !!t.voicePhoneOtpExpiresAt && t.voicePhoneOtpExpiresAt.getTime() > now;
    return {
      phone: t.voicePhone ? `+${t.voicePhone}` : null,
      verifiedAt: t.voicePhoneVerifiedAt,
      pending: pendingActive
        ? {
            phone: `+${t.voicePhonePending}`,
            expiresAt: t.voicePhoneOtpExpiresAt,
            resendAvailableAt: t.voicePhoneOtpSentAt
              ? new Date(t.voicePhoneOtpSentAt.getTime() + RESEND_COOLDOWN_MS)
              : null,
            attemptsRemaining: Math.max(0, MAX_ATTEMPTS - t.voicePhoneOtpAttempts),
          }
        : null,
    };
  }

  static async sendCode(tenantId: string, rawPhone: string) {
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      throw new VoiceSettingsError(400, 'invalid_phone', 'Enter a valid phone number with country code');
    }

    const t = await loadTenant(tenantId);

    if (t.voicePhone === phone && t.voicePhoneVerifiedAt) {
      throw new VoiceSettingsError(409, 'already_verified', 'This number is already verified for your workspace');
    }

    // Deliberately generic: never reveal which workspace owns the number.
    const [taken] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.voicePhone, phone), isNotNull(tenants.voicePhoneVerifiedAt), ne(tenants.id, tenantId)))
      .limit(1);
    if (taken) {
      throw new VoiceSettingsError(409, 'phone_taken', 'This number is already registered to another workspace');
    }

    if (t.voicePhoneOtpSentAt && Date.now() - t.voicePhoneOtpSentAt.getTime() < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - t.voicePhoneOtpSentAt.getTime())) / 1000);
      throw new VoiceSettingsError(429, 'cooldown', `Please wait ${waitSec}s before requesting another code`);
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

    const sent = await WhatsAppService.sendVerificationCode(phone, code);
    if (!sent.success) {
      logger.error({ tenantId, phone: maskPhone(phone), error: sent.error }, '[VoiceSettings] Failed to send verification code');
      throw new VoiceSettingsError(502, 'send_failed', 'Could not send the code on WhatsApp. Check the number and try again.');
    }

    const now = new Date();
    await db
      .update(tenants)
      .set({
        voicePhonePending: phone,
        voicePhoneOtpHash: hashCode(tenantId, phone, code),
        voicePhoneOtpExpiresAt: new Date(now.getTime() + OTP_TTL_MS),
        voicePhoneOtpSentAt: now,
        voicePhoneOtpAttempts: 0,
        updatedAt: now,
      })
      .where(eq(tenants.id, tenantId));

    return this.getSettings(tenantId);
  }

  static async verifyCode(tenantId: string, userId: string, code: string) {
    const t = await loadTenant(tenantId);

    if (!t.voicePhonePending || !t.voicePhoneOtpHash || !t.voicePhoneOtpExpiresAt) {
      throw new VoiceSettingsError(400, 'no_pending', 'No verification in progress. Request a new code.');
    }
    if (t.voicePhoneOtpExpiresAt.getTime() < Date.now()) {
      throw new VoiceSettingsError(400, 'expired', 'The code has expired. Request a new code.');
    }
    if (t.voicePhoneOtpAttempts >= MAX_ATTEMPTS) {
      throw new VoiceSettingsError(429, 'too_many_attempts', 'Too many incorrect attempts. Request a new code.');
    }

    const matches = safeEqualHex(hashCode(tenantId, t.voicePhonePending, code), t.voicePhoneOtpHash);
    if (!matches) {
      const attempts = t.voicePhoneOtpAttempts + 1;
      await db.update(tenants).set({ voicePhoneOtpAttempts: attempts }).where(eq(tenants.id, tenantId));
      const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
      throw new VoiceSettingsError(400, 'wrong_code', `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
    }

    try {
      await db
        .update(tenants)
        .set({
          voicePhone: t.voicePhonePending,
          voicePhoneVerifiedAt: new Date(),
          voicePhoneUserId: userId,
          voicePhonePending: null,
          voicePhoneOtpHash: null,
          voicePhoneOtpExpiresAt: null,
          voicePhoneOtpSentAt: null,
          voicePhoneOtpAttempts: 0,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));
    } catch (err: any) {
      // Unique violation: another workspace verified the same number in the meantime
      if (err?.code === '23505' || String(err?.message).includes('tenants_voice_phone_unique')) {
        throw new VoiceSettingsError(409, 'phone_taken', 'This number is already registered to another workspace');
      }
      throw err;
    }

    logger.info({ tenantId, userId, phone: maskPhone(t.voicePhonePending) }, '[VoiceSettings] Voice number verified');
    return this.getSettings(tenantId);
  }

  static async removeNumber(tenantId: string) {
    await db
      .update(tenants)
      .set({
        voicePhone: null,
        voicePhoneVerifiedAt: null,
        voicePhoneUserId: null,
        voicePhonePending: null,
        voicePhoneOtpHash: null,
        voicePhoneOtpExpiresAt: null,
        voicePhoneOtpSentAt: null,
        voicePhoneOtpAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));
    return this.getSettings(tenantId);
  }
}
