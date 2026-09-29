import crypto from 'crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { tenantVoiceNumbers } from '../../db/schema/tenant_voice_numbers';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { normalizePhone, maskPhone } from '../../lib/phone';
import { WhatsAppService } from '../../services/whatsapp.service';
import { WhatsAppBotsService } from '../whatsapp-bots/whatsapp-bots.service';
import { logger } from '../../config/logger';

const OTP_TTL_MS = 10 * 60 * 1000;      // code valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;   // one code per minute
const MAX_ATTEMPTS = 5;                 // wrong guesses before a new code is required
export const MAX_VOICE_NUMBERS = 10;    // verified numbers per workspace

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

const listNumbers = (tenantId: string) =>
  db.select().from(tenantVoiceNumbers).where(eq(tenantVoiceNumbers.tenantId, tenantId)).orderBy(asc(tenantVoiceNumbers.verifiedAt));

/** The member whose WhatsApp number this is (Members → WhatsApp number), if any. */
async function memberWithPhone(tenantId: string, phone: string): Promise<string | null> {
  const [member] = await withTenant<{ id: string }[]>(tenantId, (tx) =>
    tx.select({ id: users.id }).from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.phone, phone), isNull(users.deletedAt)))
      .limit(1),
  );
  return member?.id ?? null;
}

export class VoiceSettingsService {
  static async getSettings(tenantId: string) {
    const t = await loadTenant(tenantId);
    const numbers = await listNumbers(tenantId);

    // Names of the members the numbers belong to (users has RLS: read in the tenant context)
    const userIds = [...new Set(numbers.map((n) => n.userId).filter((id): id is string => !!id))];
    const people = userIds.length
      ? await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
          tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, userIds)),
        )
      : [];
    const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));

    const now = Date.now();
    const pendingActive = !!t.voicePhonePending && !!t.voicePhoneOtpExpiresAt && t.voicePhoneOtpExpiresAt.getTime() > now;
    return {
      numbers: numbers.map((n) => ({
        phone: `+${n.phone}`,
        verifiedAt: n.verifiedAt,
        userName: n.userId ? nameOf.get(n.userId) ?? null : null,
      })),
      maxNumbers: MAX_VOICE_NUMBERS,
      // The first number, for clients from before several numbers were supported
      phone: numbers[0] ? `+${numbers[0].phone}` : null,
      verifiedAt: numbers[0]?.verifiedAt ?? null,
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

    const [existing] = await db.select().from(tenantVoiceNumbers).where(eq(tenantVoiceNumbers.phone, phone)).limit(1);
    if (existing?.tenantId === tenantId) {
      throw new VoiceSettingsError(409, 'already_verified', 'This number is already verified for your workspace');
    }
    // Deliberately generic: never reveal which workspace owns the number.
    if (existing) {
      throw new VoiceSettingsError(409, 'phone_taken', 'This number is already registered to another workspace');
    }
    if ((await listNumbers(tenantId)).length >= MAX_VOICE_NUMBERS) {
      throw new VoiceSettingsError(409, 'too_many_numbers', `A workspace can have up to ${MAX_VOICE_NUMBERS} numbers. Remove one first.`);
    }

    if (t.voicePhoneOtpSentAt && Date.now() - t.voicePhoneOtpSentAt.getTime() < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - t.voicePhoneOtpSentAt.getTime())) / 1000);
      throw new VoiceSettingsError(429, 'cooldown', `Please wait ${waitSec}s before requesting another code`);
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

    const wa = await WhatsAppBotsService.forTenant(tenantId);
    const sent = await WhatsAppService.sendVerificationCode(phone, code, { sender: wa.sender, template: wa.templates.otp, lang: wa.templates.otpLang });
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

    const phone = t.voicePhonePending;
    // Work sent from the number is "from" the member it belongs to, else from whoever verified it
    const owner = (await memberWithPhone(tenantId, phone)) ?? userId;
    try {
      await db.insert(tenantVoiceNumbers).values({ phone, tenantId, userId: owner, verifiedBy: userId });
    } catch (err: any) {
      // Primary key: another workspace verified the same number in the meantime
      if (err?.code === '23505' || String(err?.message).includes('tenant_voice_numbers_pkey')) {
        throw new VoiceSettingsError(409, 'phone_taken', 'This number is already registered to another workspace');
      }
      throw err;
    }
    await db
      .update(tenants)
      .set({
        voicePhonePending: null,
        voicePhoneOtpHash: null,
        voicePhoneOtpExpiresAt: null,
        voicePhoneOtpSentAt: null,
        voicePhoneOtpAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId));

    logger.info({ tenantId, userId, phone: maskPhone(phone) }, '[VoiceSettings] Voice number verified');
    return this.getSettings(tenantId);
  }

  /** Removes one verified number, or (no phone) every number and any verification in progress. */
  static async removeNumber(tenantId: string, rawPhone?: string) {
    if (rawPhone !== undefined) {
      const phone = normalizePhone(rawPhone);
      if (!phone) throw new VoiceSettingsError(400, 'invalid_phone', 'Enter a valid phone number with country code');
      const removed = await db
        .delete(tenantVoiceNumbers)
        .where(and(eq(tenantVoiceNumbers.tenantId, tenantId), eq(tenantVoiceNumbers.phone, phone)))
        .returning({ phone: tenantVoiceNumbers.phone });
      if (!removed.length) throw new VoiceSettingsError(404, 'not_found', 'This number is not registered for your workspace');
      logger.info({ tenantId, phone: maskPhone(phone) }, '[VoiceSettings] Voice number removed');
      return this.getSettings(tenantId);
    }

    await db.delete(tenantVoiceNumbers).where(eq(tenantVoiceNumbers.tenantId, tenantId));
    await db
      .update(tenants)
      .set({
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
