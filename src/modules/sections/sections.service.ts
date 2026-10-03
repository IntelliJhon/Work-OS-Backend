import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';

/**
 * Workspace sections a platform admin can switch on or off per workspace (tenants.sections holds only the
 * switches that differ from the default). A section that is off is hidden in the app and its API answers 403
 * section_disabled. Projects, Calendar and Voice Notes are built on work items, so they are off whenever Tasks is.
 * Who sees an enabled section inside a workspace is still decided by role permissions.
 */

export const SECTIONS = {
  projects: 'Projects',
  tasks: 'Tasks',
  calendar: 'Calendar',
  attendance: 'Attendance',
  leave: 'Leave',
  voice_notes: 'Voice Notes',
  reminders: 'Reminders',
} as const;
export type Section = keyof typeof SECTIONS;
export type Sections = Record<Section, boolean>;

const DEFAULTS: Sections = { projects: true, tasks: true, calendar: true, attendance: true, leave: true, voice_notes: true, reminders: true };
const NEEDS_TASKS: Section[] = ['projects', 'calendar', 'voice_notes'];
const CACHE_MS = 30_000;

export const isSection = (key: string): key is Section => Object.prototype.hasOwnProperty.call(SECTIONS, key);

/** What is on, from the stored switches */
export function effectiveSections(stored: unknown): Sections {
  const overrides = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as Section[]) {
    if (typeof overrides[key] === 'boolean') out[key] = overrides[key] as boolean;
  }
  if (!out.tasks) for (const key of NEEDS_TASKS) out[key] = false;
  return out;
}

const cache = new Map<string, { at: number; sections: Sections }>();

export class SectionsService {
  static async forTenant(tenantId: string): Promise<Sections> {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.sections;
    const [row] = await db.select({ sections: tenants.sections }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const sections = effectiveSections(row?.sections);
    cache.set(tenantId, { at: Date.now(), sections });
    return sections;
  }

  static async isEnabled(tenantId: string, section: Section): Promise<boolean> {
    return (await this.forTenant(tenantId))[section];
  }

  /** Stores a workspace's switches (only known sections; values equal to the default are dropped) */
  static async update(tenantId: string, input: Partial<Record<Section, boolean>>): Promise<Sections> {
    const [row] = await db.select({ sections: tenants.sections }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!row) throw Object.assign(new Error('Workspace not found'), { status: 404 });
    const next: Record<string, boolean> = { ...((row.sections ?? {}) as Record<string, boolean>) };
    for (const [key, value] of Object.entries(input)) {
      if (!isSection(key) || typeof value !== 'boolean') continue;
      if (value === DEFAULTS[key]) delete next[key];
      else next[key] = value;
    }
    await db.update(tenants).set({ sections: next, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
    cache.delete(tenantId);
    return effectiveSections(next);
  }
}

/** Refuses the request when the workspace has the section switched off. Use after authenticate. */
export const checkSection = (section: Section) => async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (await SectionsService.isEnabled(req.user!.tenantId, section)) return next();
    return res.status(403).json({ error: `${SECTIONS[section]} is turned off for this workspace`, code: 'section_disabled', section });
  } catch (err) {
    return next(err);
  }
};

/** Signs the request in, then checkSection */
export const requireSection = (section: Section) => (req: AuthRequest, res: Response, next: NextFunction) =>
  authenticate(req as any, res, () => checkSection(section)(req, res, next));
