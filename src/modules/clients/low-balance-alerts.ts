import { eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../../db';
import { lowBalanceAlerts, lowBalanceWatch } from '../../db/schema/low_balance_alerts';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { WhatsAppService } from '../../services/whatsapp.service';
import { everyRound } from '../../jobs/background-clock';
import { fetchAgencyWallets, fetchPartnerChannels } from './partner-channels';

/**
 * WhatsApp to the team (LOW_BALANCE_ALERT_NUMBERS) when an active channel of a watched client (switched on on the
 * Onboarded Clients page) has less than LOW_BALANCE_LIMIT in its conversation wallet (clients whose panel subscription
 * has expired are skipped), or when the agency's own Partner Panel wallets that pay for client top-ups run low. A low channel gets one alert straight away, one reminder at REMINDER_HOUR on
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

/** Something that is low: a client's channel, or one of the agency's own Partner Panel wallets */
interface LowItem {
  key: string;
  userId: string | null;
  name: string;
  number: string;
  balance: number;
  template: string;
  params: string[];
}

const rupees = (n: number, currency = 'INR') => `${currency === 'INR' ? '₹' : `${currency} `}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function lowClientChannels(): Promise<LowItem[]> {
  const watched = new Set((await db.select({ userId: lowBalanceWatch.userId }).from(lowBalanceWatch)).map((w) => w.userId));
  if (!watched.size) return [];
  const [channels, live] = await Promise.all([fetchPartnerChannels(), liveClientIds()]);
  return channels
    .filter((c) => c.active && c.userId && watched.has(c.userId) && live.has(c.userId) && c.balance < env.LOW_BALANCE_LIMIT)
    .map((c) => ({
      key: c.id, userId: c.userId, name: c.name, number: c.number, balance: c.balance,
      template: env.WHATSAPP_LOW_BALANCE_TEMPLATE, params: [c.name, c.number || '-', rupees(c.balance, c.currency)],
    }));
}

/** The agency's own wallets that the client top-ups are paid from */
async function lowAgencyWallets(): Promise<LowItem[]> {
  const w = await fetchAgencyWallets();
  const out: LowItem[] = [];
  if (w.main && w.main.balance < env.AGENCY_LOW_MAIN_LIMIT) {
    out.push({ key: 'agency:main', userId: null, name: 'Partner Panel main wallet', number: '', balance: w.main.balance,
      template: env.WHATSAPP_AGENCY_LOW_BALANCE_TEMPLATE, params: ['main wallet', rupees(w.main.balance, w.main.currency)] });
  }
  if (w.conversation && w.conversation.balance < env.AGENCY_LOW_COIN_LIMIT) {
    out.push({ key: 'agency:coin', userId: null, name: 'Partner Panel conversation wallet', number: '', balance: w.conversation.balance,
      template: env.WHATSAPP_AGENCY_LOW_BALANCE_TEMPLATE, params: ['conversation wallet', `${w.conversation.balance.toLocaleString('en-IN', { maximumFractionDigits: 2 })} coins`] });
  }
  return out;
}

export async function checkLowBalances() {
  if (!env.AUTOMATIONS_BUILDER_API_TOKEN) return;
  const numbers = env.LOW_BALANCE_ALERT_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean);
  const low = [...(await lowClientChannels()), ...(await lowAgencyWallets())];

  // Topped up (or no longer counted): forget them, so a new drop alerts straight away
  const lowKeys = low.map((x) => x.key);
  await db.delete(lowBalanceAlerts).where(lowKeys.length ? notInArray(lowBalanceAlerts.channelId, lowKeys) : undefined);
  if (!low.length || !numbers.length) return;

  const known = await db.select().from(lowBalanceAlerts).where(inArray(lowBalanceAlerts.channelId, lowKeys));
  const sentBefore = new Map(known.map((k) => [k.channelId, k]));
  let sent = 0;
  for (const item of low) {
    const before = sentBefore.get(item.key);
    if (before && (before.alertCount >= MAX_ALERTS || !reminderDue(before.alertedAt))) continue;
    let ok = false;
    for (const to of numbers) {
      const r = await WhatsAppService.sendBodyTemplate(to, item.template, env.WHATSAPP_WORK_TEMPLATE_LANG, item.params);
      if (r.success) ok = true;
      else logger.warn({ item: item.key, error: r.error }, '[LowBalance] Alert failed');
    }
    // Remembered only once a message went out, so a template that is not approved yet does not swallow the alert
    if (!ok) continue;
    sent++;
    const row = { userId: item.userId, name: item.name.slice(0, 255), number: item.number.slice(0, 32), balance: item.balance.toFixed(3), alertedAt: new Date() };
    if (before) await db.update(lowBalanceAlerts).set({ ...row, alertCount: before.alertCount + 1 }).where(eq(lowBalanceAlerts.channelId, item.key));
    else await db.insert(lowBalanceAlerts).values({ channelId: item.key, ...row, alertCount: 1 });
  }
  logger.info({ low: low.length, sent }, '[LowBalance] Wallets checked');
}

/** Runs with the other background checks (every 15 min, not at night) */
export function startLowBalanceAlerts() {
  everyRound('low conversation balance', checkLowBalances);
}
