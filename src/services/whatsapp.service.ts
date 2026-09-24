import { logger } from '../config/logger';
import { env } from '../config/env';

export interface WhatsAppComplaintAlertPayload {
  ticketId: string;
  channel: 'waau' | 'direct-sms';
  complainantName: string;
  complainantPhone: string;
  company?: string;
  details: string;
  category?: string;
  imageUrl?: string;
  createdAt?: string;
}

export class WhatsAppService {
  private static getApiConfig() {
    const crmApiUrl = (process.env.CRM_API_URL || env.CRM_API_URL || 'https://crmapi.waau.in/api/meta').replace(/\/$/, '');
    const apiVersion = process.env.CRM_API_VERSION || 'v19.0';
    const accessToken = process.env.CRM_API_ACCESS_TOKEN || process.env.WHATSAPP_API_ACCESS_TOKEN || env.CRM_API_ACCESS_TOKEN || 'nN4nTt9OSg5MkY1MksuWT3VmMfTkMIYhSghRJcAREFTSAoetUtHWYNrleHTUXzEmsREFTSAEqnPgpf6OQ75GYg4oM3rXFE0bORedVU5ERVJTQ09SRQY56ho939eYgJz1H88zR855ikVU5ERVJTQ09SRQ6sVeIIw';
    const phoneNumberId = process.env.CRM_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || env.CRM_PHONE_NUMBER_ID || '810611068796796';
    const developerPhones = (process.env.DEVELOPER_WHATSAPP_NUMBERS || process.env.DEVELOPER_PHONE_NUMBER || '917736956474,919061451636')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    // List of target endpoints to attempt in order (custom CRM endpoint first, fallback to Meta Graph API)
    const targetUrls = [
      `${crmApiUrl}/${apiVersion}/${phoneNumberId}/messages`,
      `${crmApiUrl}/${phoneNumberId}/messages`,
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`
    ];

    return {
      accessToken,
      phoneNumberId,
      developerPhones,
      targetUrls
    };
  }

  /**
   * Send WhatsApp Complaint Template Message to Developer(s) / Receiver
   * Uses template name: "complaint"
   * Parameter {{1}}: Complaint Details
   * Parameter {{2}}: Client / Complainant Name
   * Parameter {{3}}: Contact Phone Number
   * Parameter {{4}}: Logged Time
   */
  static async sendComplaintAlert(complaint: WhatsAppComplaintAlertPayload, customRecipient?: string): Promise<boolean> {
    const { accessToken, phoneNumberId, developerPhones, targetUrls } = this.getApiConfig();

    if (!accessToken || !phoneNumberId) {
      logger.warn('[WhatsAppService] Access Token or Phone Number ID not configured in environment.');
      return false;
    }

    const recipients = customRecipient ? [customRecipient] : developerPhones;
    if (recipients.length === 0) {
      logger.warn('[WhatsAppService] No developer phone numbers configured to receive alerts.');
      return false;
    }

    const complaintText = `[${complaint.ticketId}] ${complaint.details}`;
    const clientName = complaint.complainantName || 'Client';
    const contactPhone = complaint.complainantPhone || 'N/A';
    const formattedTime = new Date(complaint.createdAt || Date.now()).toLocaleString();

    let allSuccess = true;

    for (const recipient of recipients) {
      const cleanRecipient = recipient.replace(/[^0-9]/g, '');
      let recipientSent = false;

      const payload = {
        messaging_product: 'whatsapp',
        to: cleanRecipient,
        recipient_type: 'individual',
        type: 'template',
        template: {
          name: 'complaint',
          language: {
            policy: 'deterministic',
            code: 'en'
          },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: complaintText },   // {{1}} Complaint
                { type: 'text', text: clientName },      // {{2}} Client
                { type: 'text', text: contactPhone },    // {{3}} Contact
                { type: 'text', text: formattedTime }    // {{4}} Time
              ]
            }
          ]
        }
      };

      for (const apiUrl of targetUrls) {
        try {
          logger.info(`[WhatsAppService] Attempting WhatsApp dispatch to ${cleanRecipient} via ${apiUrl}...`);

          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });

          const data = await res.json();
          if (res.ok) {
            logger.info(`[WhatsAppService] Successfully sent "complaint" template alert for #${complaint.ticketId} to ${cleanRecipient} via ${apiUrl}`);
            recipientSent = true;
            break; // Stop trying fallback endpoints for this recipient
          } else {
            logger.warn({ data, url: apiUrl }, `[WhatsAppService] API returned error for endpoint ${apiUrl}`);
          }
        } catch (err: any) {
          logger.warn({ err, url: apiUrl }, `[WhatsAppService] Failed to reach endpoint ${apiUrl}`);
        }
      }

      if (!recipientSent) {
        logger.error(`[WhatsAppService] Failed to deliver WhatsApp alert to ${cleanRecipient} across all attempted endpoints.`);
        allSuccess = false;
      }
    }

    return allSuccess;
  }

  /**
   * Send WhatsApp Expiry Summary Alert to Admin / Team Number
   * Uses template name: "complaint" (or custom template)
   */
  static async sendExpirySummaryAlert(summaryText: string, recipientPhone: string): Promise<{ success: boolean; error?: string; apiResponse?: any }> {
    const { accessToken, phoneNumberId, targetUrls } = this.getApiConfig();

    if (!accessToken || !phoneNumberId) {
      const errStr = 'Access Token or Phone Number ID not configured in environment.';
      logger.warn(`[WhatsAppService] ${errStr}`);
      return { success: false, error: errStr };
    }

    let cleanRecipient = recipientPhone.replace(/[^0-9]/g, '');
    if (cleanRecipient.length === 10) {
      cleanRecipient = `91${cleanRecipient}`;
    }

    // 1. Try sending direct free-form text message so it renders cleanly without complaint template wrapper
    const textPayload = {
      messaging_product: 'whatsapp',
      to: cleanRecipient,
      recipient_type: 'individual',
      type: 'text',
      text: {
        body: summaryText,
      },
    };

    // 2. Fallback template payload if free-form text is rejected outside 24h window
    const truncatedSummary = summaryText.length > 1000 ? summaryText.substring(0, 997) + '...' : summaryText;
    const formattedTime = new Date().toLocaleString();

    const templatePayload = {
      messaging_product: 'whatsapp',
      to: cleanRecipient,
      recipient_type: 'individual',
      type: 'template',
      template: {
        name: 'complaint',
        language: {
          policy: 'deterministic',
          code: 'en'
        },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: truncatedSummary },     // {{1}} Summary
              { type: 'text', text: 'Work OS Expiry Audit' },// {{2}} Client Name / System
              { type: 'text', text: cleanRecipient },        // {{3}} Phone Number
              { type: 'text', text: formattedTime }          // {{4}} Time
            ]
          }
        ]
      }
    };

    let lastError = '';
    let lastData: any = null;

    // Try endpoints with text payload first
    for (const apiUrl of targetUrls) {
      try {
        logger.info(`[WhatsAppService] Dispatching direct WhatsApp expiry summary text to ${cleanRecipient} via ${apiUrl}...`);

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(textPayload),
        });

        const data = await res.json();
        if (res.ok) {
          logger.info(`[WhatsAppService] Successfully sent WhatsApp expiry summary text to ${cleanRecipient} via ${apiUrl}`);
          return { success: true, apiResponse: data };
        } else {
          lastError = `Text API HTTP ${res.status}: ${JSON.stringify(data)}`;
          lastData = data;
          logger.warn({ data, url: apiUrl }, `[WhatsAppService] Text API returned error for endpoint ${apiUrl}`);
        }
      } catch (err: any) {
        lastError = `Fetch error: ${err.message}`;
        logger.warn({ err, url: apiUrl }, `[WhatsAppService] Failed to reach endpoint ${apiUrl}`);
      }
    }

    // Fallback: Try template payload if text payload failed
    for (const apiUrl of targetUrls) {
      try {
        logger.info(`[WhatsAppService] Dispatching fallback template expiry summary to ${cleanRecipient} via ${apiUrl}...`);

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(templatePayload),
        });

        const data = await res.json();
        if (res.ok) {
          logger.info(`[WhatsAppService] Successfully sent fallback template expiry summary to ${cleanRecipient} via ${apiUrl}`);
          return { success: true, apiResponse: data };
        } else {
          lastError = `Template API HTTP ${res.status}: ${JSON.stringify(data)}`;
          lastData = data;
          logger.warn({ data, url: apiUrl }, `[WhatsAppService] Template API returned error for endpoint ${apiUrl}`);
        }
      } catch (err: any) {
        lastError = `Fetch error: ${err.message}`;
        logger.warn({ err, url: apiUrl }, `[WhatsAppService] Failed to reach endpoint ${apiUrl}`);
      }
    }

    return { success: false, error: lastError, apiResponse: lastData };
  }

  /**
   * Send WhatsApp 1-Day Expiry Template Message directly to individual client
   * Uses template name: "subscription_expiry_1day"
   * Parameter {{1}}: Client Name
   * Parameter {{2}}: Expiry Date
   */
  static async sendIndividual1DayExpiryAlert(
    clientName: string,
    expiryDateFormatted: string,
    recipientPhone: string
  ): Promise<{ success: boolean; error?: string; apiResponse?: any }> {
    const { accessToken, phoneNumberId, targetUrls } = this.getApiConfig();

    if (!accessToken || !phoneNumberId) {
      const errStr = 'Access Token or Phone Number ID not configured in environment.';
      logger.warn(`[WhatsAppService] ${errStr}`);
      return { success: false, error: errStr };
    }

    let cleanRecipient = recipientPhone.replace(/[^0-9]/g, '');
    if (cleanRecipient.length === 10) {
      cleanRecipient = `91${cleanRecipient}`;
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: cleanRecipient,
      recipient_type: 'individual',
      type: 'template',
      template: {
        name: 'subscription_expiry_1day',
        language: {
          policy: 'deterministic',
          code: 'en'
        },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: clientName || 'Client' },
              { type: 'text', text: expiryDateFormatted }
            ]
          }
        ]
      }
    };

    let lastError = '';
    let lastData: any = null;

    for (const apiUrl of targetUrls) {
      try {
        logger.info(`[WhatsAppService] Dispatching 1-day expiry template alert to ${cleanRecipient} via ${apiUrl}...`);

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (res.ok) {
          logger.info(`[WhatsAppService] Successfully sent 1-day expiry template alert to ${cleanRecipient} via ${apiUrl}`);
          return { success: true, apiResponse: data };
        } else {
          lastError = `HTTP ${res.status}: ${JSON.stringify(data)}`;
          lastData = data;
          logger.warn({ data, url: apiUrl }, `[WhatsAppService] WhatsApp API returned error for endpoint ${apiUrl}`);
        }
      } catch (err: any) {
        lastError = `Fetch error: ${err.message}`;
        logger.warn({ err, url: apiUrl }, `[WhatsAppService] Failed to reach endpoint ${apiUrl}`);
      }
    }

    return { success: false, error: lastError, apiResponse: lastData };
  }

  /**
   * Send a phone verification code using a Meta "Authentication" category template.
   * Template (create in WAAU / Meta Business Manager): name = env.WHATSAPP_OTP_TEMPLATE,
   * body "{{1}} is your verification code." with a "Copy code" button.
   * Meta requires the code in both the body parameter and the button URL parameter.
   */
  static async sendVerificationCode(recipientPhone: string, code: string): Promise<{ success: boolean; error?: string }> {
    return this.sendTemplateMessage(recipientPhone, env.WHATSAPP_OTP_TEMPLATE, env.WHATSAPP_OTP_TEMPLATE_LANG, [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
    ]);
  }

  /**
   * Send a template with body variables {{1}}..{{n}} in order. Meta rejects variables containing
   * newlines, tabs or more than 4 consecutive spaces, so values are flattened and length-capped.
   */
  static async sendBodyTemplate(
    recipientPhone: string,
    templateName: string,
    languageCode: string,
    bodyParams: string[],
  ): Promise<{ success: boolean; error?: string }> {
    const parameters = bodyParams.map((value) => ({
      type: 'text',
      text: String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300) || '-',
    }));
    return this.sendTemplateMessage(recipientPhone, templateName, languageCode, [{ type: 'body', parameters }]);
  }

  /**
   * Free-form text message. Meta only delivers these inside the 24-hour window after the recipient
   * last messaged the business (e.g. a reply to someone who just sent the bot a voice note).
   */
  static async sendText(recipientPhone: string, text: string): Promise<{ success: boolean; error?: string }> {
    return this.postMessage(recipientPhone, 'text', { type: 'text', text: { preview_url: false, body: text.slice(0, 4000) } });
  }

  private static async sendTemplateMessage(
    recipientPhone: string,
    templateName: string,
    languageCode: string,
    components: unknown[],
  ): Promise<{ success: boolean; error?: string }> {
    return this.postMessage(recipientPhone, templateName, {
      type: 'template',
      template: {
        name: templateName,
        language: { policy: 'deterministic', code: languageCode },
        components,
      },
    });
  }

  private static async postMessage(
    recipientPhone: string,
    label: string,
    message: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string }> {
    const { accessToken, phoneNumberId, targetUrls } = this.getApiConfig();
    if (!accessToken || !phoneNumberId) {
      return { success: false, error: 'WhatsApp API is not configured' };
    }

    const to = recipientPhone.replace(/[^0-9]/g, '');
    const payload = { messaging_product: 'whatsapp', to, recipient_type: 'individual', ...message };

    let lastError = 'Unknown error';
    for (const apiUrl of targetUrls) {
      try {
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data: any = await res.json().catch(() => ({}));
        if (res.ok) {
          logger.info({ message: label, to: to.slice(-4) }, '[WhatsAppService] Message sent');
          return { success: true };
        }
        lastError = data?.error?.message || `HTTP ${res.status}`;
        logger.warn({ url: apiUrl, message: label, error: lastError }, '[WhatsAppService] Message dispatch failed on endpoint');
      } catch (err: any) {
        lastError = err?.message || String(err);
        logger.warn({ url: apiUrl, message: label, error: lastError }, '[WhatsAppService] Message request error');
      }
    }
    return { success: false, error: lastError };
  }
}

