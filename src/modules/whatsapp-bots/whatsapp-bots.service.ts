import { asc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { tenantWhatsappBots } from '../../db/schema/tenant_whatsapp_bots';
import { decryptSecret, encryptSecret, isEncryptionConfigured, maskSecret } from '../../lib/crypto';
import { normalizePhone } from '../../lib/phone';
import { WhatsAppSender } from '../../services/whatsapp.service';
import { env } from '../../config/env';

/** How a workspace talks on WhatsApp: its own bot, or the platform default (sender undefined). */
export interface TenantWhatsApp {
  sender?: WhatsAppSender;
  /** Phone number ID of the bot that serves this workspace (default bot if none configured) */
  botId: string;
  businessPhone: string | null;
  templates: { otp: string; owner: string; employee: string; lang: string; otpLang: string };
}

export class WhatsAppBotError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const defaultBotId = (): string => env.CRM_PHONE_NUMBER_ID;

export class WhatsAppBotsService {
  static async forTenant(tenantId: string): Promise<TenantWhatsApp> {
    const [bot] = await db.select().from(tenantWhatsappBots).where(eq(tenantWhatsappBots.tenantId, tenantId)).limit(1);
    const defaults = {
      otp: env.WHATSAPP_OTP_TEMPLATE,
      owner: env.WHATSAPP_WORK_OWNER_TEMPLATE,
      employee: env.WHATSAPP_WORK_EMPLOYEE_TEMPLATE,
      lang: env.WHATSAPP_WORK_TEMPLATE_LANG,
      otpLang: env.WHATSAPP_OTP_TEMPLATE_LANG,
    };
    if (!bot) return { botId: defaultBotId(), businessPhone: null, templates: defaults };

    // A configured bot must be used: replies from another number would fall outside WhatsApp's 24h window
    return {
      sender: { accessToken: decryptSecret(bot.accessTokenEncrypted), phoneNumberId: bot.phoneNumberId },
      botId: bot.phoneNumberId,
      businessPhone: bot.businessPhone,
      templates: {
        otp: bot.otpTemplate || defaults.otp,
        owner: bot.ownerTemplate || defaults.owner,
        employee: bot.employeeTemplate || defaults.employee,
        lang: bot.templateLang || defaults.lang,
        otpLang: bot.templateLang || defaults.otpLang,
      },
    };
  }

  /**
   * The sender for a bot ID passed by n8n (URL segment); undefined = platform default bot.
   * null = a bot Work OS has no token for (e.g. removed on the WhatsApp Bots screen): no reply can be
   * sent through it, and replying through another number would reach the sender from a chat they didn't use.
   */
  static async senderForBot(botId: string | null | undefined): Promise<WhatsAppSender | undefined | null> {
    if (!botId || botId === defaultBotId()) return undefined;
    const [bot] = await db.select().from(tenantWhatsappBots).where(eq(tenantWhatsappBots.phoneNumberId, botId)).limit(1);
    return bot ? { accessToken: decryptSecret(bot.accessTokenEncrypted), phoneNumberId: bot.phoneNumberId } : null;
  }

  /** Whether Work OS serves this bot: the platform default bot, or one saved on the WhatsApp Bots screen. */
  static async isRegisteredBot(botId: string | null | undefined): Promise<boolean> {
    if (!botId || botId === defaultBotId()) return true;
    const [bot] = await db
      .select({ phoneNumberId: tenantWhatsappBots.phoneNumberId })
      .from(tenantWhatsappBots)
      .where(eq(tenantWhatsappBots.phoneNumberId, botId))
      .limit(1);
    return !!bot;
  }

  /**
   * A workspace must be reached through its own bot (or the default bot if it has none).
   * Returns null when the message came in through the right bot, otherwise the bot to use instead
   * (ownBot false = the platform default bot).
   */
  static async wrongBot(tenantId: string, botId: string | null | undefined): Promise<null | { businessPhone: string | null; ownBot: boolean }> {
    const receiving = botId || defaultBotId();
    const [bot] = await db
      .select({ phoneNumberId: tenantWhatsappBots.phoneNumberId, businessPhone: tenantWhatsappBots.businessPhone })
      .from(tenantWhatsappBots)
      .where(eq(tenantWhatsappBots.tenantId, tenantId))
      .limit(1);
    const expected = bot?.phoneNumberId ?? defaultBotId();
    return receiving === expected ? null : { businessPhone: bot?.businessPhone ?? null, ownBot: !!bot };
  }

  // ---------- Platform admin ----------

  static async listForAdmin() {
    const rows = await db
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        slug: tenants.slug,
        isActive: tenants.isActive,
        bot: tenantWhatsappBots,
      })
      .from(tenants)
      .leftJoin(tenantWhatsappBots, eq(tenantWhatsappBots.tenantId, tenants.id))
      .orderBy(asc(tenants.name));

    return {
      encryptionConfigured: isEncryptionConfigured(),
      defaultBotId: defaultBotId(),
      workspaces: rows.map((r) => ({
        tenantId: r.tenantId,
        name: r.tenantName,
        slug: r.slug,
        isActive: r.isActive,
        bot: r.bot
          ? {
              phoneNumberId: r.bot.phoneNumberId,
              businessPhone: r.bot.businessPhone ? `+${r.bot.businessPhone}` : null,
              accessTokenMasked: WhatsAppBotsService.maskStoredToken(r.bot.accessTokenEncrypted),
              otpTemplate: r.bot.otpTemplate,
              ownerTemplate: r.bot.ownerTemplate,
              employeeTemplate: r.bot.employeeTemplate,
              templateLang: r.bot.templateLang,
              updatedAt: r.bot.updatedAt,
            }
          : null,
      })),
    };
  }

  static async upsert(
    tenantId: string,
    userId: string,
    input: {
      phoneNumberId: string;
      accessToken?: string | null;
      businessPhone?: string | null;
      otpTemplate?: string | null;
      ownerTemplate?: string | null;
      employeeTemplate?: string | null;
      templateLang?: string | null;
    },
  ) {
    if (!isEncryptionConfigured()) {
      throw new WhatsAppBotError(503, 'encryption_not_configured', 'SECRETS_ENCRYPTION_KEY is not set on the server');
    }
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new WhatsAppBotError(404, 'tenant_not_found', 'Workspace not found');
    if (input.phoneNumberId === defaultBotId()) {
      throw new WhatsAppBotError(400, 'default_bot', 'That is the platform default bot; remove the custom bot instead');
    }

    const [owner] = await db
      .select({ tenantId: tenantWhatsappBots.tenantId })
      .from(tenantWhatsappBots)
      .where(eq(tenantWhatsappBots.phoneNumberId, input.phoneNumberId))
      .limit(1);
    if (owner && owner.tenantId !== tenantId) {
      throw new WhatsAppBotError(409, 'bot_taken', 'This phone number ID is already used by another workspace');
    }

    const [existing] = await db.select().from(tenantWhatsappBots).where(eq(tenantWhatsappBots.tenantId, tenantId)).limit(1);
    const token = input.accessToken?.trim();
    if (!existing && !token) throw new WhatsAppBotError(400, 'token_required', 'Access token is required');

    const businessPhone = input.businessPhone ? normalizePhone(input.businessPhone) : null;
    if (input.businessPhone && !businessPhone) throw new WhatsAppBotError(400, 'invalid_phone', 'Enter a valid WhatsApp number');

    const values = {
      phoneNumberId: input.phoneNumberId,
      businessPhone,
      otpTemplate: input.otpTemplate || null,
      ownerTemplate: input.ownerTemplate || null,
      employeeTemplate: input.employeeTemplate || null,
      templateLang: input.templateLang || null,
      updatedBy: userId,
      updatedAt: new Date(),
      ...(token ? { accessTokenEncrypted: encryptSecret(token) } : {}),
    };

    if (existing) {
      await db.update(tenantWhatsappBots).set(values).where(eq(tenantWhatsappBots.tenantId, tenantId));
    } else {
      await db.insert(tenantWhatsappBots).values({ tenantId, accessTokenEncrypted: encryptSecret(token!), ...values });
    }
  }

  static async remove(tenantId: string) {
    await db.delete(tenantWhatsappBots).where(eq(tenantWhatsappBots.tenantId, tenantId));
  }

  private static maskStoredToken(encrypted: string): string {
    try {
      return maskSecret(decryptSecret(encrypted));
    } catch {
      return '(cannot decrypt – re-enter the token)';
    }
  }
}
