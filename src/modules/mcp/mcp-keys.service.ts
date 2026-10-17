import crypto from 'crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { mcpKeys } from '../../db/schema/mcp_keys';
import { tenants } from '../../db/schema/tenants';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { SectionsService } from '../sections/sections.service';

/**
 * Access keys for the Work OS MCP server. An Admin creates a key for a workspace and picks the sections it may
 * read; the key is shown once (only its SHA-256 hash is kept). Keys are read-only and can be revoked at any time.
 */

/** What a key can be given. "people" (names, roles) is always readable so other answers can name people. */
export const MCP_SECTIONS = {
  tasks: 'Tasks',
  projects: 'Projects',
  attendance: 'Attendance',
  leave: 'Leave',
  hours: 'Hours and work reports',
  clients: 'Clients',
  reminders: 'Reminders',
  groups: 'Group chats',
} as const;
export type McpSection = keyof typeof MCP_SECTIONS;
export const isMcpSection = (s: string): s is McpSection => Object.prototype.hasOwnProperty.call(MCP_SECTIONS, s);

// The workspace section that must be switched on for each key section
const NEEDS: Record<McpSection, string> = {
  tasks: 'tasks', projects: 'projects', attendance: 'attendance', leave: 'leave', hours: 'tasks', clients: 'clients', reminders: 'reminders', groups: 'groups',
};

export class McpKeyError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const hash = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

export interface McpContext { keyId: string; tenantId: string; keyName: string; sections: Set<McpSection> }

export class McpKeysService {
  static async list(tenantId: string) {
    const rows = await db.select().from(mcpKeys).where(eq(mcpKeys.tenantId, tenantId)).orderBy(desc(mcpKeys.createdAt));
    const ids = [...new Set(rows.map((r) => r.createdBy).filter((v): v is string => !!v))];
    const creators = ids.length
      ? await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
        tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.tenantId, tenantId)))
      : [];
    const names = new Map(creators.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return rows.map((r) => ({
      id: r.id, name: r.name, prefix: r.prefix, sections: r.sections, createdBy: r.createdBy ? names.get(r.createdBy) ?? null : null,
      createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, useCount: r.useCount, revokedAt: r.revokedAt,
    }));
  }

  /** Makes a key; the full key is returned only here */
  static async create(tenantId: string, actorId: string, input: { name: string; sections: string[] }) {
    const name = input.name.trim();
    if (name.length < 2) throw new McpKeyError(400, 'name', 'Give the key a name, e.g. "n8n daily report"');
    const sections = [...new Set(input.sections)].filter(isMcpSection);
    if (!sections.length) throw new McpKeyError(400, 'sections', 'Choose at least one section the key may read');
    const active = await db.select({ n: sql<number>`count(*)::int` }).from(mcpKeys).where(and(eq(mcpKeys.tenantId, tenantId), isNull(mcpKeys.revokedAt)));
    if ((active[0]?.n ?? 0) >= 20) throw new McpKeyError(400, 'too_many', 'A workspace can have at most 20 active keys. Revoke one you no longer use.');
    const key = `wos_mcp_${crypto.randomBytes(24).toString('base64url')}`;
    const [row] = await db.insert(mcpKeys).values({ tenantId, name, keyHash: hash(key), prefix: key.slice(0, 14), sections, createdBy: actorId }).returning();
    return { id: row.id, name: row.name, prefix: row.prefix, sections: row.sections, key };
  }

  static async revoke(tenantId: string, keyId: string) {
    const [row] = await db.update(mcpKeys).set({ revokedAt: new Date() })
      .where(and(eq(mcpKeys.id, keyId), eq(mcpKeys.tenantId, tenantId), isNull(mcpKeys.revokedAt))).returning();
    if (!row) throw new McpKeyError(404, 'not_found', 'Key not found or already revoked');
    return { revoked: true };
  }

  /** The workspace and sections a key may read (sections switched off for the workspace are dropped); null = refused */
  static async authenticate(key: string | undefined): Promise<McpContext | null> {
    if (!key || !key.startsWith('wos_mcp_') || key.length > 100) return null;
    const [row] = await db.select().from(mcpKeys).where(and(eq(mcpKeys.keyHash, hash(key)), isNull(mcpKeys.revokedAt))).limit(1);
    if (!row) return null;
    const [t] = await db.select({ active: tenants.isActive }).from(tenants).where(eq(tenants.id, row.tenantId)).limit(1);
    if (!t?.active) return null;
    const on = await SectionsService.forTenant(row.tenantId);
    const sections = new Set((row.sections ?? []).filter(isMcpSection).filter((s) => (on as Record<string, boolean>)[NEEDS[s]] !== false));
    // Usage (best effort)
    db.update(mcpKeys).set({ lastUsedAt: new Date(), useCount: sql`${mcpKeys.useCount} + 1` }).where(eq(mcpKeys.id, row.id)).catch(() => {});
    return { keyId: row.id, tenantId: row.tenantId, keyName: row.name, sections };
  }
}
