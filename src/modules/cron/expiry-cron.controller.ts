import { Request, Response } from 'express';
import { db } from '../../db';
import { subscriptionExpiryAlerts } from '../../db/schema/subscription_expiry_alerts';
import { tenants } from '../../db/schema/tenants';
import { eq, and, gte } from 'drizzle-orm';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { WhatsAppService } from '../../services/whatsapp.service';

export class ExpiryCronController {
  static async checkSubscriptionExpiries(req: Request, res: Response) {
    try {
      // 1. Authenticate Cron Secret Header or Query Param
      const providedSecret = req.headers['x-cron-secret'] || req.query.secret || req.body?.secret;
      const expectedSecret = env.CRON_SECRET || 'workos_expiry_cron_secret_2026';

      if (providedSecret !== expectedSecret) {
        logger.warn({ msg: 'Unauthorized cron trigger attempt', providedSecret });
        return res.status(401).json({ error: 'Unauthorized: Invalid x-cron-secret header token' });
      }

      // 2. Determine target admin recipient number for Option B Summary Alert
      const targetRecipient =
        String(req.body?.targetNumber || req.query.targetNumber || env.EXPIRY_ALERT_TEST_NUMBER || '7736956474').trim();

      // 3. Fetch all client users from Automations Builder Partner API
      const apiBase = env.AUTOMATIONS_BUILDER_API_BASE || 'https://partner-api.automationsbuilder.com';
      const apiToken = env.AUTOMATIONS_BUILDER_API_TOKEN;

      const limit = 50;
      let page = 1;
      let hasMore = true;
      const allClients: any[] = [];

      while (hasMore && page <= 20) {
        const url = `${apiBase}/api/v1/users?page=${page}&limit=${limit}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          logger.error({ msg: 'Failed fetching users from partner API in cron', status: response.status, page });
          break;
        }

        const json: any = await response.json();
        const batch = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);

        if (batch.length === 0) {
          hasMore = false;
        } else {
          allClients.push(...batch);
          if (batch.length < limit) hasMore = false;
          else page++;
        }
      }

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Get existing sent alerts for today to prevent duplicates
      const alertsToday = await db
        .select()
        .from(subscriptionExpiryAlerts)
        .where(gte(subscriptionExpiryAlerts.sentAt, todayStart));

      const sentAlertsKeySet = new Set(
        alertsToday.map(a => `${a.clientId}_${a.alertMilestone}`)
      );

      const upcomingExpiries: any[] = [];
      const expiredAccounts: any[] = [];
      const newAlertsToInsert: any[] = [];

      for (const client of allClients) {
        if (!client.expiry) continue;

        const expiryDate = new Date(client.expiry);
        if (isNaN(expiryDate.getTime())) continue;

        const diffMs = expiryDate.getTime() - now.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        const firstName = client.profile?.name?.first || '';
        const lastName = client.profile?.name?.last || '';
        const fullName = `${firstName} ${lastName}`.trim() || client.email?.split('@')[0] || 'Client';

        let milestone: string | null = null;

        if (diffDays === 7) milestone = '7_DAYS_BEFORE';
        else if (diffDays === 3) milestone = '3_DAYS_BEFORE';
        else if (diffDays === 1) milestone = '1_DAY_BEFORE';
        else if (diffDays <= 0) milestone = 'EXPIRED';

        const clientInfo = {
          id: client.id,
          name: fullName,
          email: client.email,
          expiryDate: expiryDate.toISOString(),
          diffDays,
          milestone,
        };

        if (diffDays <= 7 && diffDays > 0) {
          upcomingExpiries.push(clientInfo);
        } else if (diffDays <= 0) {
          expiredAccounts.push(clientInfo);
        }

        if (milestone) {
          const alertKey = `${client.id}_${milestone}`;
          if (!sentAlertsKeySet.has(alertKey)) {
            newAlertsToInsert.push({
              clientId: client.id,
              clientName: fullName,
              clientEmail: client.email,
              recipientNumber: targetRecipient,
              alertMilestone: milestone,
              expiryDate: expiryDate,
              sentAt: now,
            });
            sentAlertsKeySet.add(alertKey);
          }
        }
      }

      // Record new alerts in database
      if (newAlertsToInsert.length > 0) {
        await db.insert(subscriptionExpiryAlerts).values(newAlertsToInsert);
      }

      // Construct Option B Summary Report for Admin Number 7736956474
      const formattedDate = now.toLocaleDateString('en-US', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const summaryText = [
        `🚨 WORK OS - SUBSCRIPTION EXPIRY SUMMARY REPORT`,
        `📱 Target Recipient: ${targetRecipient}`,
        `⏰ Scheduled Trigger Time: 10:00 AM (${formattedDate})`,
        ``,
        `📊 SUMMARY OVERVIEW:`,
        `• Total Clients Audited: ${allClients.length}`,
        `• Upcoming Expiries (<= 7 days): ${upcomingExpiries.length}`,
        `• Expired Accounts: ${expiredAccounts.length}`,
        `• New Alert Logs Recorded Today: ${newAlertsToInsert.length}`,
        ``,
        `⚠️ UPCOMING EXPIRIES (Next 7 Days):`,
        upcomingExpiries.length === 0
          ? `  (None - All accounts healthy)`
          : upcomingExpiries
              .slice(0, 10)
              .map(
                (c, i) =>
                  `  ${i + 1}. ${c.name} (${c.email})\n     Expires: ${new Date(c.expiryDate).toLocaleDateString()} (In ${c.diffDays} day${c.diffDays === 1 ? '' : 's'})`
              )
              .join('\n'),
        ``,
        `🚨 RECENTLY EXPIRED ACCOUNTS:`,
        expiredAccounts.length === 0
          ? `  (None)`
          : expiredAccounts
              .slice(0, 5)
              .map(
                (c, i) =>
                  `  ${i + 1}. ${c.name} (${c.email})\n     Expired on: ${new Date(c.expiryDate).toLocaleDateString()}`
              )
              .join('\n'),
      ].join('\n');

      // 4. Dispatch WhatsApp Summary Alert to Target Recipient
      let whatsappSent = false;
      let whatsappError: string | undefined = undefined;
      let whatsappApiResponse: any = undefined;

      try {
        const waResult = await WhatsAppService.sendExpirySummaryAlert(summaryText, targetRecipient);
        whatsappSent = waResult.success;
        whatsappApiResponse = waResult.apiResponse;
        if (!waResult.success) {
          whatsappError = waResult.error;
        }
      } catch (waErr: any) {
        whatsappError = waErr.message;
        logger.error({ msg: 'Failed to send WhatsApp summary alert in cron controller', error: waErr.message });
      }

      logger.info({
        msg: 'Successfully processed subscription expiry cron job',
        targetRecipient,
        whatsappSent,
        whatsappError,
        totalClients: allClients.length,
        upcomingCount: upcomingExpiries.length,
        expiredCount: expiredAccounts.length,
        newAlertsRecorded: newAlertsToInsert.length,
      });

      return res.json({
        success: true,
        whatsappSent,
        whatsappError,
        whatsappApiResponse,
        message: whatsappSent
          ? `Subscription expiry check completed. Summary sent via WhatsApp to ${targetRecipient}.`
          : `Subscription expiry check completed, but WhatsApp message failed to deliver to ${targetRecipient}: ${whatsappError || 'Unknown error'}`,
        timestamp: now.toISOString(),
        targetRecipient,
        stats: {
          totalAudited: allClients.length,
          upcomingExpiriesCount: upcomingExpiries.length,
          expiredAccountsCount: expiredAccounts.length,
          newAlertsRecorded: newAlertsToInsert.length,
        },
        summaryReportText: summaryText,
        upcomingExpiries,
        expiredAccounts,
      });
    } catch (err: any) {
      logger.error({ msg: 'ExpiryCronController.checkSubscriptionExpiries error', error: err.message });
      return res.status(500).json({ error: 'Failed executing subscription expiry cron job', details: err.message });
    }
  }
}
