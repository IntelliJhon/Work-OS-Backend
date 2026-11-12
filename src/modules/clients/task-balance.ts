import https from 'node:https';
import tls from 'node:tls';
import { eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../../db';
import { clientTaskBalance, taskBalanceWatch, taskLowAlerts, walletTopups } from '../../db/schema/low_balance_alerts';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { SSL2BUY_EMEA_RSA_DV_CA } from '../../config/certs/ssl2buy';
import { WhatsAppService } from '../../services/whatsapp.service';
import { everyRound } from '../../jobs/background-clock';
import { TopUpError } from './wallet-topups';

/**
 * WAAU automation task balance (Task Allotted / Consumed / Remaining under Automation → Analytics in the client's panel).
 * WAAU has no partner API for it (confirmed by WAAU support, who said to use "Create Magic Link"), so it is read the way
 * the panel does: a one-time login link from the Partner API → the panel's master-login swaps it for the client's
 * session → the panel's task analytics. Read only; the session token is used once and never stored or logged.
 *
 * Once a day from TASK_CHECK_HOUR (WORK_TIMEZONE) the watched clients are read one by one, and the team
 * (LOW_BALANCE_ALERT_NUMBERS) gets a WhatsApp when a client has fewer than TASK_LOW_LIMIT tasks left: one alert, one
 * reminder the next day, then no more until tasks are added. Tasks are added by subscribing the client to the TASK
 * add-on (TASK_ADDON_PLAN_ID) through the Partner API.
 */

const MAPI = 'https://mapi.1automations.com';
// The panel API's server does not send its intermediate certificate; trust it for this host only (checks stay on)
const mapiAgent = new https.Agent({ ca: [...tls.rootCertificates, SSL2BUY_EMEA_RSA_DV_CA], keepAlive: false });
const MAX_ALERTS = 2;
// Pause between clients in the daily round, so the panel does not see a burst of logins
const GAP_MS = 3_000;

export interface TaskBalance { total: number; consumed: number; remaining: number }

export class TaskBalanceError extends Error {}

const partnerBase = () => (env.AUTOMATIONS_BUILDER_API_BASE || 'https://partner-api.automationsbuilder.com').replace(/\/$/, '');
const partnerHeaders = () => ({ Authorization: `Bearer ${env.AUTOMATIONS_BUILDER_API_TOKEN ?? ''}`, Accept: 'application/json', 'Content-Type': 'application/json' });

function mapiPost(path: string, body: unknown, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(`${MAPI}${path}`, {
      method: 'POST', agent: mapiAgent, timeout: 20_000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch { reject(new TaskBalanceError(`The WAAU panel answered ${res.statusCode} with no data`)); }
      });
    });
    req.on('timeout', () => req.destroy(new TaskBalanceError('The WAAU panel did not answer in time')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Reads one client's task balance live (about 3 calls) */
export async function fetchTaskBalance(userId: string): Promise<TaskBalance> {
  if (!env.AUTOMATIONS_BUILDER_API_TOKEN) throw new TaskBalanceError('The Partner Panel API key is not set');
  const res = await fetch(`${partnerBase()}/api/v1/user_login/${encodeURIComponent(userId)}`, { headers: partnerHeaders(), signal: AbortSignal.timeout(20_000) });
  const link: string | undefined = res.ok ? ((await res.json().catch(() => null)) as any)?.link : undefined;
  const hash = link ? new URL(link).pathname.split('/').filter(Boolean).pop() : undefined;
  if (!hash) throw new TaskBalanceError(`Could not get a login link from the Partner API (${res.status})`);

  const login = await mapiPost('/api/2/authentication/master-login', { token: hash });
  if (!login?.success || typeof login.token !== 'string') throw new TaskBalanceError('The WAAU panel refused the login link');

  const a = await mapiPost('/api/task/analytics', {}, login.token);
  const d = a?.data;
  if (!a?.success || typeof d?.remaining !== 'number') throw new TaskBalanceError('The WAAU panel did not return the task balance');
  return { total: Number(d.total) || 0, consumed: Number(d.consumed) || 0, remaining: Number(d.remaining) };
}

/** Reads and stores one client's balance; a failure is stored too (the last good reading is kept) */
export async function refreshTaskBalance(userId: string, name: string | null) {
  try {
    const b = await fetchTaskBalance(userId);
    const row = { name: name?.slice(0, 255) ?? null, ...b, checkedAt: new Date(), error: null, errorAt: null };
    await db.insert(clientTaskBalance).values({ userId, ...row }).onConflictDoUpdate({ target: clientTaskBalance.userId, set: row });
    return { ok: true as const, ...b };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    await db.insert(clientTaskBalance).values({ userId, name: name?.slice(0, 255) ?? null, error, errorAt: new Date() })
      .onConflictDoUpdate({ target: clientTaskBalance.userId, set: { error, errorAt: new Date() } });
    logger.warn({ userId, error }, '[TaskBalance] Read failed');
    return { ok: false as const, error };
  }
}

/** Last readings, with whether each client is watched, for the Onboarded Clients page */
export async function taskBalances() {
  const [rows, watch] = await Promise.all([db.select().from(clientTaskBalance), db.select({ userId: taskBalanceWatch.userId }).from(taskBalanceWatch)]);
  const watched = new Set(watch.map((w) => w.userId));
  const out: Record<string, { total: number | null; consumed: number | null; remaining: number | null; checkedAt: Date | null; error: string | null; errorAt: Date | null; watched: boolean }> = {};
  for (const r of rows) out[r.userId] = { total: r.total, consumed: r.consumed, remaining: r.remaining, checkedAt: r.checkedAt, error: r.error, errorAt: r.errorAt, watched: watched.has(r.userId) };
  for (const id of watched) if (!out[id]) out[id] = { total: null, consumed: null, remaining: null, checkedAt: null, error: null, errorAt: null, watched: true };
  return out;
}

export async function setTaskWatch(userId: string, name: string, on: boolean, by: string) {
  if (on) await db.insert(taskBalanceWatch).values({ userId, name: name.slice(0, 255), addedBy: by }).onConflictDoNothing();
  else await db.delete(taskBalanceWatch).where(eq(taskBalanceWatch.userId, userId));
  return { on };
}

/**
 * Adds tasks by subscribing the client to the TASK add-on (Admins only, checked by the route). WAAU bills the add-on
 * as it does from the Partner Panel. Logged in the recharge history.
 */
export async function addTasks(input: { tenantId: string; userId: string; clientId: string; clientName: string | null; note: string | null }) {
  if (!env.TASK_ADDON_PLAN_ID) throw new TopUpError(503, 'The task add-on is not set up');
  const res = await fetch(`${partnerBase()}/api/v1/user/${encodeURIComponent(input.clientId)}/subscribe/addon`, {
    method: 'POST', headers: partnerHeaders(), body: JSON.stringify({ plan_id: env.TASK_ADDON_PLAN_ID, validity: env.TASK_ADDON_VALIDITY }), signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => null);
  const ok = res.ok && data?.success !== false;
  // WAAU sometimes answers 200 with success:false and the reason in another field; keep the whole reply (short)
  const reason = data?.message || data?.msg || data?.error || data?.errors || data?.data?.message;
  const error = ok ? null : (reason ? String(typeof reason === 'string' ? reason : JSON.stringify(reason)) : `Partner API answered ${res.status}: ${JSON.stringify(data ?? null).slice(0, 300)}`);
  await db.insert(walletTopups).values({
    tenantId: input.tenantId, clientId: input.clientId, clientName: input.clientName, wallet: 'tasks',
    amount: String(env.TASK_ADDON_TASKS), note: input.note, status: ok ? 'done' : 'failed', error, addedBy: input.userId,
  });
  if (!ok) {
    logger.warn({ clientId: input.clientId, status: res.status, error }, '[TaskBalance] Task add-on failed');
    throw new TopUpError(502, `The tasks were not added: ${error}`);
  }
  // The new balance (best effort)
  const after = await refreshTaskBalance(input.clientId, input.clientName);
  return { added: env.TASK_ADDON_TASKS, remaining: after.ok ? after.remaining : null };
}

const localDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: env.WORK_TIMEZONE });
const localHour = (d: Date) => Number(d.toLocaleString('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: env.WORK_TIMEZONE }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The day of the last finished round (in memory; a restart re-reads at most once more that day) */
let lastRoundDay: string | null = null;

export async function checkTaskBalances(force = false) {
  if (!env.AUTOMATIONS_BUILDER_API_TOKEN) return;
  const now = new Date();
  if (!force && (localHour(now) < env.TASK_CHECK_HOUR || lastRoundDay === localDay(now))) return;
  const watch = await db.select().from(taskBalanceWatch);
  // Read today already (e.g. before a restart)? Then do not log in again
  const today = localDay(now);
  const done = new Map((await db.select().from(clientTaskBalance)).filter((r) => r.checkedAt && localDay(r.checkedAt) === today).map((r) => [r.userId, r]));
  const low: { userId: string; name: string; remaining: number; total: number }[] = [];
  let read = 0;
  for (const w of watch) {
    let r = done.get(w.userId);
    if (!r || force) {
      if (read++) await sleep(GAP_MS);
      const got = await refreshTaskBalance(w.userId, w.name);
      if (!got.ok) continue;
      r = { remaining: got.remaining, total: got.total } as any;
    }
    // A client with no tasks allotted at all does not use automation: nothing to alert about
    if (r && r.remaining !== null && (r.total ?? 0) > 0 && r.remaining < env.TASK_LOW_LIMIT) low.push({ userId: w.userId, name: w.name, remaining: r.remaining, total: r.total ?? 0 });
  }
  lastRoundDay = today;
  await sendLowTaskAlerts(low);
  logger.info({ watched: watch.length, read, low: low.length }, '[TaskBalance] Daily check done');
}

async function sendLowTaskAlerts(low: { userId: string; name: string; remaining: number; total: number }[]) {
  const lowIds = low.map((l) => l.userId);
  // Back above the limit (tasks added) or no longer watched: forget, so the next drop alerts at once
  await db.delete(taskLowAlerts).where(lowIds.length ? notInArray(taskLowAlerts.userId, lowIds) : undefined);
  const numbers = env.LOW_BALANCE_ALERT_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean);
  if (!low.length || !numbers.length) return;
  const known = new Map((await db.select().from(taskLowAlerts).where(inArray(taskLowAlerts.userId, lowIds))).map((k) => [k.userId, k]));
  const today = localDay(new Date());
  for (const l of low) {
    const before = known.get(l.userId);
    // One alert, then one reminder on a later day, then none
    if (before && (before.alertCount >= MAX_ALERTS || localDay(before.alertedAt) === today)) continue;
    let ok = false;
    for (const to of numbers) {
      const r = await WhatsAppService.sendBodyTemplate(to, env.WHATSAPP_TASK_LOW_TEMPLATE, env.WHATSAPP_WORK_TEMPLATE_LANG,
        [l.name, l.remaining.toLocaleString('en-IN'), l.total.toLocaleString('en-IN')]);
      if (r.success) ok = true;
      else logger.warn({ userId: l.userId, error: r.error }, '[TaskBalance] Alert failed');
    }
    if (!ok) continue;
    const row = { name: l.name.slice(0, 255), remaining: l.remaining, alertedAt: new Date() };
    if (before) await db.update(taskLowAlerts).set({ ...row, alertCount: before.alertCount + 1 }).where(eq(taskLowAlerts.userId, l.userId));
    else await db.insert(taskLowAlerts).values({ userId: l.userId, ...row, alertCount: 1 });
  }
}

/** Runs with the other background checks; does its real work once a day from TASK_CHECK_HOUR */
export function startTaskBalanceChecks() {
  everyRound('automation task balance', () => checkTaskBalances());
}
