import { Request, Response } from 'express';
import { db } from '../../db';
import { subscriptionExpiryAlerts } from '../../db/schema/subscription_expiry_alerts';
import { gte } from 'drizzle-orm';
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

      // 2. Determine target recipient number for alerts
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

      const isForce = req.query.force === 'true' || req.body?.force === true;

      // Get existing sent alerts for today to prevent duplicates (bypassed if force=true)
      const alertsToday = isForce
        ? []
        : await db
            .select()
            .from(subscriptionExpiryAlerts)
            .where(gte(subscriptionExpiryAlerts.sentAt, todayStart));

      const sentAlertsKeySet = new Set(
        alertsToday.map(a => `${a.clientId}_${a.alertMilestone}`)
      );

      const upcomingExpiries: any[] = [];
      const expiredAccounts: any[] = [];
      const newAlertsToInsert: any[] = [];
      const individualAlertsSent: any[] = [];

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

        // Send individual 1-Day Expiry Template Message if milestone is 1_DAY_BEFORE
        if (milestone === '1_DAY_BEFORE') {
          const alertKey = `${client.id}_${milestone}`;
          if (!sentAlertsKeySet.has(alertKey)) {
            const clientPhone = String(client.phone || client.profile?.phone || client.mobile || targetRecipient).trim();
            const expiryDateFormatted = expiryDate.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });

            try {
              const res1Day = await WhatsAppService.sendIndividual1DayExpiryAlert(fullName, expiryDateFormatted, clientPhone);
              individualAlertsSent.push({
                clientId: client.id,
                clientName: fullName,
                phone: clientPhone,
                sent: res1Day.success,
                error: res1Day.error,
              });
            } catch (err1Day: any) {
              logger.error({ msg: 'Failed sending 1-day individual alert in cron', client: fullName, error: err1Day.message });
            }

            newAlertsToInsert.push({
              clientId: client.id,
              clientName: fullName,
              clientEmail: client.email,
              recipientNumber: clientPhone,
              alertMilestone: milestone,
              expiryDate: expiryDate,
              sentAt: now,
            });
            sentAlertsKeySet.add(alertKey);
          }
        }
      }

      // If no natural 1-day alert was triggered today, send the subscription_expiry_1day template to targetRecipient with upcoming client info
      if (individualAlertsSent.length === 0) {
        const targetClient = upcomingExpiries.length > 0 ? upcomingExpiries[0] : { name: 'Work OS Client', expiryDate: new Date(Date.now() + 86400000 * 7).toISOString() };
        const expiryDateFormatted = new Date(targetClient.expiryDate).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
        try {
          const res1DayAlert = await WhatsAppService.sendIndividual1DayExpiryAlert(targetClient.name, expiryDateFormatted, targetRecipient);
          individualAlertsSent.push({
            clientId: targetClient.id || 'upcoming_client_alert',
            clientName: targetClient.name,
            phone: targetRecipient,
            sent: res1DayAlert.success,
            error: res1DayAlert.error,
            isTargetRecipientAlert: true,
          });
        } catch (testErr: any) {
          logger.error({ msg: 'Failed sending targetRecipient 1-day individual alert in cron', error: testErr.message });
        }
      }

      // Record new alerts in database
      if (newAlertsToInsert.length > 0) {
        await db.insert(subscriptionExpiryAlerts).values(newAlertsToInsert);
      }

      logger.info({
        msg: 'Successfully processed subscription expiry cron job (template only)',
        targetRecipient,
        totalClients: allClients.length,
        upcomingCount: upcomingExpiries.length,
        expiredCount: expiredAccounts.length,
        newAlertsRecorded: newAlertsToInsert.length,
        individual1DayAlertsSentCount: individualAlertsSent.length,
      });

      return res.json({
        success: true,
        message: `Subscription expiry check completed. Meta WhatsApp template (subscription_expiry_1day) dispatched.`,
        timestamp: now.toISOString(),
        targetRecipient,
        stats: {
          totalAudited: allClients.length,
          upcomingExpiriesCount: upcomingExpiries.length,
          expiredAccountsCount: expiredAccounts.length,
          newAlertsRecorded: newAlertsToInsert.length,
          individual1DayAlertsSentCount: individualAlertsSent.length,
        },
        individual1DayAlertsSent: individualAlertsSent,
        upcomingExpiries,
        expiredAccounts,
      });
    } catch (err: any) {
      logger.error({ msg: 'ExpiryCronController.checkSubscriptionExpiries error', error: err.message });
      return res.status(500).json({ error: 'Failed executing subscription expiry cron job', details: err.message });
    }
  }
}

