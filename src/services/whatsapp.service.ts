import { logger } from '../config/logger';

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
    const crmApiUrl = (process.env.CRM_API_URL || 'https://crmapi.waau.in/api/meta').replace(/\/$/, '');
    const apiVersion = process.env.CRM_API_VERSION || 'v19.0';
    const accessToken = process.env.CRM_API_ACCESS_TOKEN || process.env.WHATSAPP_API_ACCESS_TOKEN || '';
    const phoneNumberId = process.env.CRM_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '810611068796796';
    const developerPhones = (process.env.DEVELOPER_WHATSAPP_NUMBERS || process.env.DEVELOPER_PHONE_NUMBER || '919061451636')
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
  static async sendExpirySummaryAlert(summaryText: string, recipientPhone: string): Promise<boolean> {
    const { accessToken, phoneNumberId, targetUrls } = this.getApiConfig();

    if (!accessToken || !phoneNumberId) {
      logger.warn('[WhatsAppService] Access Token or Phone Number ID not configured in environment.');
      return false;
    }

    let cleanRecipient = recipientPhone.replace(/[^0-9]/g, '');
    if (cleanRecipient.length === 10) {
      cleanRecipient = `91${cleanRecipient}`;
    }

    // Limit parameter text length to Meta WhatsApp limits (max 1024 chars per text param)
    const truncatedSummary = summaryText.length > 1000 ? summaryText.substring(0, 997) + '...' : summaryText;
    const formattedTime = new Date().toLocaleString();

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
              { type: 'text', text: truncatedSummary },     // {{1}} Summary
              { type: 'text', text: 'Work OS Expiry Audit' },// {{2}} Client Name / System
              { type: 'text', text: cleanRecipient },        // {{3}} Phone Number
              { type: 'text', text: formattedTime }          // {{4}} Time
            ]
          }
        ]
      }
    };

    let sent = false;

    for (const apiUrl of targetUrls) {
      try {
        logger.info(`[WhatsAppService] Dispatching WhatsApp expiry summary alert to ${cleanRecipient} via ${apiUrl}...`);

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
          logger.info(`[WhatsAppService] Successfully sent WhatsApp expiry summary alert to ${cleanRecipient} via ${apiUrl}`);
          sent = true;
          break;
        } else {
          logger.warn({ data, url: apiUrl }, `[WhatsAppService] WhatsApp API returned error for endpoint ${apiUrl}`);
        }
      } catch (err: any) {
        logger.warn({ err, url: apiUrl }, `[WhatsAppService] Failed to reach endpoint ${apiUrl}`);
      }
    }

    return sent;
  }
}

