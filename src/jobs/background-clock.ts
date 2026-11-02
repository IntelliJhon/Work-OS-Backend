import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * One clock for the in-process background checks (reminders, escalations, place names). The database (Neon)
 * sleeps after 5 idle minutes and is billed while awake, so the checks run together in one round every
 * BACKGROUND_EVERY_MIN minutes (on the clock: :00, :15, …) instead of each on its own every minute, and not at
 * night (BACKGROUND_NIGHT_FROM–UNTIL, local time). One round also runs shortly after the server starts.
 * Work that must happen at an exact moment (a task's reminder) sets its own timer.
 */

interface Check {
  name: string;
  run: () => Promise<unknown>;
  running: boolean;
}

const checks: Check[] = [];
let started = false;

function localHour(d: Date): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: env.WORK_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(d).split(':').map(Number);
  return h + m / 60;
}

export function isNight(d: Date = new Date()): boolean {
  const from = env.BACKGROUND_NIGHT_FROM;
  const until = env.BACKGROUND_NIGHT_UNTIL;
  if (from === until) return false;
  const h = localHour(d);
  return from > until ? h >= from || h < until : h >= from && h < until;
}

async function runCheck(c: Check) {
  if (c.running) return;
  c.running = true;
  try {
    await c.run();
  } catch (err) {
    logger.error({ err, check: c.name }, '[Background] Check failed');
  } finally {
    c.running = false;
  }
}

async function runRound() {
  for (const c of checks) await runCheck(c);
}

function scheduleNextRound() {
  const every = env.BACKGROUND_EVERY_MIN * 60_000;
  // A couple of seconds past the mark, so a check at 18:00 sees 18:00
  const wait = every - (Date.now() % every) + 2_000;
  setTimeout(async () => {
    if (!isNight()) await runRound();
    scheduleNextRound();
  }, wait);
}

/** Adds a check to every round */
export function everyRound(name: string, run: () => Promise<unknown>) {
  checks.push({ name, run, running: false });
  if (started) return;
  started = true;
  // The startup round runs even at night: it also sets the exact timers for the reminders ahead
  setTimeout(() => void runRound(), 20_000);
  scheduleNextRound();
  logger.info(`[Background] Checks run every ${env.BACKGROUND_EVERY_MIN} min, paused ${env.BACKGROUND_NIGHT_FROM}:00–${env.BACKGROUND_NIGHT_UNTIL}:00`);
}
