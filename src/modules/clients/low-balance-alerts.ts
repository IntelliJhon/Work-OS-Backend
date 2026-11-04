import { eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../../db';
import { lowBalanceAlerts, lowBalanceWatch } from '../../db/schema/low_balance_alerts';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { WhatsAppService } from '../../services/whatsapp.service';
import { everyRound } from '../../jobs/background-clock';
import { fetchPartnerChannels } from './partner-channels';

/**
 * WhatsApp to the team (LOW_BALANCE_ALERT_NUMBERS) when an active channel of a watched client (switched on on the
 * Onboarded Clients page) has less than LOW_BALANCE_LIMIT in its conversation wallet. Clients whose panel
 * subscription has expired are skipped. A low channel gets one alert straight away, one reminder at REMINDER_HOUR on
 * a later day, then no more until it is topped up again (then the next drop alerts at once).
 */

// The first alert and one reminder
const MAX_ALERTS = 2;
// The reminder goes out from this local hour (WORK_TIMEZONE) on a day after the first alert
const REMINDER_HOUR = 10;

const localDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: env.WORK_TIMEZONE });
const localHour = (d: Date) => Number(d.toLocaleString('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: env.WORK_TIMEZONE }));
const reminderDue = (firstAlert: Date, now = new Date()) => localDay(now) > localDay(firstAlert) && localHour(now) >= REMINDER_HOUR;

async function liveClientIds(): Promise<Set<string>> {
  const base = (env.AUTOMATIONS_BUILDER_API_BASE || 'https://partner-api.automationsbuilder.com').replace(/\/$/, '');
  const live = new Set<string>();
  const now = Date.now();
  for (let page = 1; page <= 25; page++) {
    const res = await fetch(`${base}/api/v1/users?page=${page}&limit=20`, {
      headers: { Authorization: `Bearer ${env.AUTOMATIONS_BUILDER_API_TOKEN ?? ''}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Partner API answered ${res.status}`);
    const json: any = await res.json();
    const batch: any[] = Array.isArray(json?.data) ? json.data : [];
    for (const u of batch) {
      const expiry = u.expiry ? new Date(u.expiry).getTime() : NaN;
      if (!Number.isNaN(expiry) && expiry > now) live.add(String(u.id));
    }
    if (batch.length < 20) break;
  }
  return live;
}

export async function checkLowBalances() {
  if (!env.AUTOMATIONS_BUILDER_API_TOKEN) return;
  const limit = env.LOW_BALANCE_LIMIT;
  const numbers = env.LOW_BALANCE_ALERT_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean);
  const watched = new Set((await db.select({ userId: lowBalanceWatch.userId }).from(lowBalanceWatch)).map((w) => w.userId));
  if (!watched.size) {
    await db.delete(lowBalanceAlerts);
    return;
  }
  const [channels, live] = await Promise.all([fetchPartnerChannels(), liveClientIds()]);
  const low = channels.filter((c) => c.active && c.userId && watched.has(c.userId) && live.has(c.userId) && c.balance < limit);

  // Topped up (or no longer counted): forget them, so a new drop alerts straight away
  const lowIds = low.map((c) => c.id);
  await db.delete(lowBalanceAlerts).where(lowIds.length ? notInArray(lowBalanceAlerts.channelId, lowIds) : undefined);
  if (!low.length || !numbers.length) return;

  const known = await db.select().from(lowBalanceAlerts).where(inArray(lowBalanceAlerts.channelId, lowIds));
  const sentBefore = new Map(known.map((k) => [k.channelId, k]));
  let sent = 0;
  for (const c of low) {
    const before = sentBefore.get(c.id);
    if (before && (before.alertCount >= MAX_ALERTS || !reminderDue(before.alertedAt))) continue;
    const amount = `${c.currency === 'INR' ? '₹' : `${c.currency} `}${c.balance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    let ok = false;
    for (const to of numbers) {
      const r = await WhatsAppService.sendBodyTemplate(to, env.WHATSAPP_LOW_BALANCE_TEMPLATE, env.WHATSAPP_WORK_TEMPLATE_LANG, [c.name, c.number || '-', amount]);
      if (r.success) ok = true;
      else logger.warn({ channel: c.id, error: r.error }, '[LowBalance] Alert failed');
    }
    // Remembered only once a message went out, so a template that is not approved yet does not swallow the alert
    if (!ok) continue;
    sent++;
    const row = { userId: c.userId, name: c.name.slice(0, 255), number: c.number.slice(0, 32), balance: c.balance.toFixed(3), alertedAt: new Date() };
    if (before) await db.update(lowBalanceAlerts).set({ ...row, alertCount: before.alertCount + 1 }).where(eq(lowBalanceAlerts.channelId, c.id));
    else await db.insert(lowBalanceAlerts).values({ channelId: c.id, ...row, alertCount: 1 });
  }
  logger.info({ low: low.length, sent }, '[LowBalance] Conversation wallets checked');
}

/** Runs with the other background checks (every 15 min, not at night) */
export function startLowBalanceAlerts() {
  everyRound('low conversation balance', checkLowBalances);
}
