// Locks an account's login for a while after repeated wrong passwords, whatever IP the guesses come from.
// Kept in memory (one server instance); a restart clears it, which is acceptable for a 15-minute lock.
export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

const failures = new Map<string, number[]>();
const lockedUntil = new Map<string, number>();

const keyFor = (workspace: string, email: string) => `${workspace.trim().toLowerCase()}|${email.trim().toLowerCase()}`;

/** Milliseconds left on the lock, or 0 when the login may be tried. */
export function lockRemaining(workspace: string, email: string, now = Date.now()): number {
  const key = keyFor(workspace, email);
  const until = lockedUntil.get(key);
  if (!until) return 0;
  if (until > now) return until - now;
  lockedUntil.delete(key);
  return 0;
}

/** Records a wrong password; returns the lock length when this failure locks the account. */
export function recordFailure(workspace: string, email: string, now = Date.now()): number {
  const key = keyFor(workspace, email);
  const recent = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  if (recent.length >= MAX_FAILURES) {
    failures.delete(key);
    lockedUntil.set(key, now + LOCK_MS);
    return LOCK_MS;
  }
  failures.set(key, recent);
  return 0;
}

export function recordSuccess(workspace: string, email: string) {
  failures.delete(keyFor(workspace, email));
}

// Drop stale entries now and then so the maps cannot grow without bound
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of failures) if (ts.every((t) => now - t >= WINDOW_MS)) failures.delete(k);
  for (const [k, until] of lockedUntil) if (until <= now) lockedUntil.delete(k);
}, WINDOW_MS).unref();
