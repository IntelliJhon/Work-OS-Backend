import { and, asc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { attendanceRecords } from '../../db/schema/attendance';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Place names for check-in locations ("Kakkanad, Kochi"), from OpenStreetMap's free reverse lookup (Nominatim).
 * Its usage policy allows at most one request a second from an identified app, so a background job names a few
 * check-ins at a time, one per second, and remembers recent answers. Check-ins themselves never wait for it.
 */

const LOOKUP_URL = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'IntelliJohn-WorkOS/1.0 (+https://work-os-liart.vercel.app)';
const GAP_MS = 1100;
const BATCH = 20;
const MAX_LEN = 200;

interface Address {
  amenity?: string; building?: string; office?: string; shop?: string; tourism?: string;
  road?: string; neighbourhood?: string; suburb?: string; quarter?: string; hamlet?: string; village?: string;
  town?: string; city?: string; municipality?: string; county?: string; state_district?: string; state?: string;
}

/** A short, readable name: the place (if it has one), the area, and the town or city */
export function placeName(result: { name?: string; address?: Address } | null | undefined): string {
  if (!result?.address) return '';
  const a = result.address;
  const place = result.name || a.amenity || a.building || a.office || a.shop || a.tourism || '';
  const area = a.neighbourhood || a.suburb || a.quarter || a.hamlet || a.village || a.road || '';
  const town = a.city || a.town || a.municipality || a.county || a.state_district || a.state || '';
  const parts: string[] = [];
  for (const p of [place, area, town]) {
    const t = p.trim();
    if (t && !parts.some((x) => x.toLowerCase() === t.toLowerCase())) parts.push(t);
  }
  return parts.join(', ').slice(0, MAX_LEN);
}

// Recent answers by position (rounded to about 11 m), so people checking in at the same office cost one lookup
const cache = new Map<string, string>();
const key = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

export const geocoder = {
  /** One lookup; '' when there is no name for the place. Throws on network or service errors. */
  async lookup(lat: number, lng: number): Promise<string> {
    const url = `${LOOKUP_URL}?format=jsonv2&zoom=17&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Place lookup answered ${res.status}`);
    return placeName((await res.json()) as { name?: string; address?: Address });
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Names the check-ins of the last 60 days that have a location but no name yet (a few at a time) */
export async function nameCheckInLocations(limit = BATCH) {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ id: attendanceRecords.id, lat: attendanceRecords.latitude, lng: attendanceRecords.longitude })
    .from(attendanceRecords)
    .where(and(
      eq(attendanceRecords.locationStatus, 'ok'),
      isNotNull(attendanceRecords.latitude),
      isNotNull(attendanceRecords.longitude),
      isNull(attendanceRecords.locationName),
      gte(attendanceRecords.day, since),
    ))
    .orderBy(asc(attendanceRecords.checkInAt))
    .limit(limit);
  let named = 0;
  let calls = 0;
  for (const r of rows) {
    const k = key(r.lat!, r.lng!);
    let name = cache.get(k);
    if (name === undefined) {
      if (calls++) await sleep(GAP_MS);
      try {
        name = await geocoder.lookup(r.lat!, r.lng!);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[Attendance] Place name lookup failed; will try again later');
        break;
      }
      cache.set(k, name);
      if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
    }
    await db.update(attendanceRecords).set({ locationName: name }).where(and(eq(attendanceRecords.id, r.id), isNull(attendanceRecords.locationName)));
    named++;
  }
  return named;
}

export function startLocationNames() {
  if (env.TASK_REMINDERS_ENABLED === 'false') return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await nameCheckInLocations();
      if (n) logger.info({ named: n }, '[Attendance] Named check-in locations');
    } catch (err) {
      logger.error({ err }, '[Attendance] Naming check-in locations failed');
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 25_000);
  setInterval(tick, 30_000);
  logger.info('[Attendance] Check-in locations get place names from OpenStreetMap');
}
