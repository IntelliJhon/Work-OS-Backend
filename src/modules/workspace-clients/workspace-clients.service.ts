import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { clientActivity, workspaceClients, type ClientActivityKind, type ClientStatus } from '../../db/schema/workspace_clients';
import { uploads } from '../../db/schema/uploads';
import { users } from '../../db/schema/users';
import { projects } from '../../db/schema/projects';
import { withTenant } from '../../middleware/tenant.middleware';
import { UploadService } from '../uploads/upload.service';
import { normalizePhone } from '../../lib/phone';
import { logger } from '../../config/logger';
import { FILE_TYPES } from '../groups/groups.service';

/**
 * The Clients section: the companies a workspace works for. Everyone with client.read sees clients and adds notes;
 * Admins and roles with client.manage add and edit clients and their documents; only Admins archive and restore.
 * Every change is written to the client's activity, so the team sees who changed what.
 */

export class ClientError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface Access { userId: string; admin: boolean; read: boolean; manage: boolean }

type Client = typeof workspaceClients.$inferSelect;
export interface ClientInput {
  name?: string;
  contactPerson?: string | null;
  phone?: string;
  email?: string | null;
  city?: string | null;
  address?: string | null;
  gstNumber?: string | null;
  category?: string | null;
  status?: ClientStatus;
  accountManagerId?: string | null;
  clientSince?: string | null;
  notes?: string | null;
  tags?: string[];
}

export const CLIENT_DOCUMENT_ENTITY = 'CLIENT';
const ACTIVITY_PAGE = 50;

// Field labels for the activity ("Changed phone and status")
const FIELD_LABELS: Record<keyof ClientInput, string> = {
  name: 'name',
  contactPerson: 'contact person',
  phone: 'WhatsApp number',
  email: 'email',
  city: 'city',
  address: 'address',
  gstNumber: 'GST number',
  category: 'category',
  status: 'status',
  accountManagerId: 'account manager',
  clientSince: 'client since',
  notes: 'about',
  tags: 'tags',
};

const fullName = (p: { firstName: string | null; lastName: string | null } | null | undefined) =>
  p ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() : null;

const blankToNull = (v: string | null | undefined) => {
  if (v === undefined) return undefined;
  const t = (v ?? '').trim();
  return t ? t : null;
};

function listText(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

async function activeMember(tenantId: string, userId: string) {
  const [u] = await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
    tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users)
      .where(and(eq(users.id, userId), eq(users.tenantId, tenantId), isNull(users.deletedAt))).limit(1),
  );
  return u ?? null;
}

async function names(tenantId: string, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
    tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, wanted))),
  );
  return new Map(rows.map((r) => [r.id, fullName(r) ?? '']));
}

export class WorkspaceClientsService {
  // ─── Access ───────────────────────────────────────────────────────────────────

  private static needRead(access: Access) {
    if (!access.read) throw new ClientError(403, 'forbidden', 'Your role cannot see clients');
  }

  private static needManage(access: Access) {
    if (!access.manage) throw new ClientError(403, 'forbidden', 'Only Admins and Project Managers can add or change clients');
  }

  private static async client(tenantId: string, clientId: string, opts: { archived?: boolean } = {}): Promise<Client> {
    const [c] = await db.select().from(workspaceClients).where(and(
      eq(workspaceClients.id, clientId),
      eq(workspaceClients.tenantId, tenantId),
      opts.archived ? undefined : isNull(workspaceClients.archivedAt),
    )).limit(1);
    if (!c) throw new ClientError(404, 'not_found', 'Client not found');
    return c;
  }

  private static async log(tenantId: string, clientId: string, actorId: string, kind: ClientActivityKind, body: string | null, meta: Record<string, unknown> = {}) {
    await db.insert(clientActivity).values({ tenantId, clientId, actorId, kind, body, meta });
  }

  private static async nameTaken(tenantId: string, name: string, exceptId?: string) {
    const [hit] = await db.select({ id: workspaceClients.id }).from(workspaceClients).where(and(
      eq(workspaceClients.tenantId, tenantId),
      isNull(workspaceClients.archivedAt),
      sql`lower(${workspaceClients.name}) = lower(${name})`,
      exceptId ? sql`${workspaceClients.id} <> ${exceptId}` : undefined,
    )).limit(1);
    return !!hit;
  }

  /** Validates and normalises the fields that were sent (all of them on create) */
  private static async clean(tenantId: string, input: ClientInput, creating: boolean) {
    const out: Partial<typeof workspaceClients.$inferInsert> = {};
    if (input.name !== undefined || creating) {
      const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length < 2) throw new ClientError(400, 'name', 'Enter the client name');
      out.name = name;
    }
    if (input.phone !== undefined || creating) {
      const phone = normalizePhone(input.phone);
      if (!phone) throw new ClientError(400, 'phone', 'Enter a valid WhatsApp number, e.g. 98765 43210 or +91 98765 43210');
      out.phone = phone;
    }
    if (input.contactPerson !== undefined) out.contactPerson = blankToNull(input.contactPerson);
    if (input.email !== undefined) out.email = blankToNull(input.email)?.toLowerCase() ?? null;
    if (input.city !== undefined) out.city = blankToNull(input.city);
    if (input.address !== undefined) out.address = blankToNull(input.address);
    if (input.gstNumber !== undefined) {
      const gst = blankToNull(input.gstNumber)?.toUpperCase().replace(/\s+/g, '') ?? null;
      if (gst && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gst)) throw new ClientError(400, 'gst', 'A GST number has 15 letters and digits, e.g. 32ABCDE1234F1Z5');
      out.gstNumber = gst;
    }
    if (input.category !== undefined) out.category = blankToNull(input.category);
    if (input.status !== undefined) out.status = input.status;
    if (input.accountManagerId !== undefined) {
      if (input.accountManagerId && !(await activeMember(tenantId, input.accountManagerId))) {
        throw new ClientError(400, 'account_manager', 'The account manager must be a member of this workspace');
      }
      out.accountManagerId = input.accountManagerId || null;
    }
    if (input.clientSince !== undefined) out.clientSince = input.clientSince || null;
    if (input.notes !== undefined) out.notes = blankToNull(input.notes);
    if (input.tags !== undefined) {
      out.tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 20);
    }
    return out;
  }

  private static async view(tenantId: string, c: Client, extra: { documents?: number } = {}) {
    const people = await names(tenantId, [c.accountManagerId, c.createdBy, c.updatedBy]);
    return {
      ...c,
      accountManagerName: c.accountManagerId ? people.get(c.accountManagerId) ?? null : null,
      createdByName: c.createdBy ? people.get(c.createdBy) ?? null : null,
      updatedByName: c.updatedBy ? people.get(c.updatedBy) ?? null : null,
      ...extra,
    };
  }

  // ─── Clients ──────────────────────────────────────────────────────────────────

  static async list(tenantId: string, access: Access, filter: { q?: string; status?: string; category?: string; managerId?: string } = {}) {
    this.needRead(access);
    const archived = filter.status === 'archived';
    const q = filter.q?.trim();
    const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const digits = q?.replace(/\D/g, '') ?? '';
    const rows = await db.select().from(workspaceClients).where(and(
      eq(workspaceClients.tenantId, tenantId),
      archived ? isNotNull(workspaceClients.archivedAt) : isNull(workspaceClients.archivedAt),
      !archived && filter.status && ['active', 'on_hold', 'former'].includes(filter.status) ? eq(workspaceClients.status, filter.status as ClientStatus) : undefined,
      filter.category ? eq(workspaceClients.category, filter.category) : undefined,
      filter.managerId ? eq(workspaceClients.accountManagerId, filter.managerId) : undefined,
      like ? or(
        ilike(workspaceClients.name, like),
        ilike(workspaceClients.contactPerson, like),
        ilike(workspaceClients.email, like),
        ilike(workspaceClients.city, like),
        ilike(workspaceClients.gstNumber, like),
        digits.length >= 4 ? ilike(workspaceClients.phone, `%${digits}%`) : undefined,
        sql`exists (select 1 from unnest(${workspaceClients.tags}) t where t ilike ${like})`,
      ) : undefined,
    )).orderBy(sql`lower(${workspaceClients.name})`).limit(2000);

    const ids = rows.map((r) => r.id);
    const docCounts = new Map<string, number>();
    const lastActivity = new Map<string, Date>();
    if (ids.length) {
      const docs = await withTenant<{ entityId: string; n: number }[]>(tenantId, (tx) =>
        tx.select({ entityId: uploads.entityId, n: sql<number>`count(*)::int` }).from(uploads)
          .where(and(eq(uploads.tenantId, tenantId), eq(uploads.entityType, CLIENT_DOCUMENT_ENTITY), inArray(uploads.entityId, ids)))
          .groupBy(uploads.entityId),
      );
      docs.forEach((d) => docCounts.set(d.entityId, d.n));
      const acts = await db.select({ clientId: clientActivity.clientId, at: sql<Date>`max(${clientActivity.createdAt})` }).from(clientActivity)
        .where(and(eq(clientActivity.tenantId, tenantId), inArray(clientActivity.clientId, ids)))
        .groupBy(clientActivity.clientId);
      acts.forEach((a) => lastActivity.set(a.clientId, new Date(a.at)));
    }
    const people = await names(tenantId, rows.map((r) => r.accountManagerId));
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      contactPerson: c.contactPerson,
      phone: c.phone,
      email: c.email,
      city: c.city,
      category: c.category,
      status: c.status,
      tags: c.tags,
      accountManagerId: c.accountManagerId,
      accountManagerName: c.accountManagerId ? people.get(c.accountManagerId) ?? null : null,
      clientSince: c.clientSince,
      archivedAt: c.archivedAt,
      createdAt: c.createdAt,
      documents: docCounts.get(c.id) ?? 0,
      lastActivityAt: lastActivity.get(c.id) ?? c.updatedAt,
    }));
  }

  /** Categories already used in the workspace, for suggestions */
  static async categories(tenantId: string, access: Access) {
    this.needRead(access);
    const rows = await db.selectDistinct({ category: workspaceClients.category }).from(workspaceClients)
      .where(and(eq(workspaceClients.tenantId, tenantId), isNotNull(workspaceClients.category)));
    return rows.map((r) => r.category as string).sort((a, b) => a.localeCompare(b));
  }

  /** Workspace members, to pick the account manager from */
  static async people(tenantId: string, access: Access) {
    this.needRead(access);
    const rows = await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
      tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt))),
    );
    return rows.map((r) => ({ id: r.id, name: fullName(r) ?? '' })).sort((a, b) => a.name.localeCompare(b.name));
  }

  static async get(tenantId: string, access: Access, clientId: string) {
    this.needRead(access);
    const c = await this.client(tenantId, clientId, { archived: true });
    return this.view(tenantId, c);
  }

  static async create(tenantId: string, access: Access, input: ClientInput) {
    this.needManage(access);
    const values = await this.clean(tenantId, input, true);
    if (await this.nameTaken(tenantId, values.name!)) {
      throw new ClientError(409, 'duplicate_name', `A client named "${values.name}" already exists`);
    }
    const [c] = await db.insert(workspaceClients).values({
      ...values,
      name: values.name!,
      phone: values.phone!,
      tenantId,
      createdBy: access.userId,
      updatedBy: access.userId,
    }).returning();
    await this.log(tenantId, c.id, access.userId, 'created', `Added ${c.name}`);
    return this.view(tenantId, c);
  }

  static async update(tenantId: string, access: Access, clientId: string, input: ClientInput) {
    this.needManage(access);
    const before = await this.client(tenantId, clientId);
    const values = await this.clean(tenantId, input, false);
    if (values.name && values.name.toLowerCase() !== before.name.toLowerCase() && await this.nameTaken(tenantId, values.name, clientId)) {
      throw new ClientError(409, 'duplicate_name', `A client named "${values.name}" already exists`);
    }
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [key, value] of Object.entries(values) as [keyof ClientInput, unknown][]) {
      const old = (before as any)[key];
      const same = Array.isArray(value) ? JSON.stringify(value) === JSON.stringify(old ?? []) : (old ?? null) === (value ?? null);
      if (!same) changes[key] = [old ?? null, value ?? null];
    }
    if (!Object.keys(changes).length) return this.view(tenantId, before);
    const [c] = await db.update(workspaceClients).set({ ...values, updatedBy: access.userId, updatedAt: new Date() })
      .where(and(eq(workspaceClients.id, clientId), eq(workspaceClients.tenantId, tenantId))).returning();
    // Projects show the client's current name
    if (changes.name) {
      await withTenant(tenantId, (tx) => tx.update(projects).set({ clientName: c.name }).where(and(eq(projects.tenantId, tenantId), eq(projects.clientId, clientId))));
    }
    const fields = Object.keys(changes).map((k) => FIELD_LABELS[k as keyof ClientInput] ?? k);
    await this.log(tenantId, clientId, access.userId, 'updated', `Changed ${listText(fields)}`, { changes });
    return this.view(tenantId, c);
  }

  static async archive(tenantId: string, access: Access, clientId: string) {
    if (!access.admin) throw new ClientError(403, 'forbidden', 'Only Admins can archive clients');
    const c = await this.client(tenantId, clientId);
    await db.update(workspaceClients).set({ archivedAt: new Date(), updatedBy: access.userId, updatedAt: new Date() }).where(eq(workspaceClients.id, c.id));
    await this.log(tenantId, c.id, access.userId, 'archived', `Archived ${c.name}`);
    return { archived: true };
  }

  static async restore(tenantId: string, access: Access, clientId: string) {
    if (!access.admin) throw new ClientError(403, 'forbidden', 'Only Admins can restore clients');
    const c = await this.client(tenantId, clientId, { archived: true });
    if (!c.archivedAt) return this.view(tenantId, c);
    if (await this.nameTaken(tenantId, c.name, c.id)) {
      throw new ClientError(409, 'duplicate_name', `Another client is already named "${c.name}". Rename that one first.`);
    }
    const [restored] = await db.update(workspaceClients).set({ archivedAt: null, updatedBy: access.userId, updatedAt: new Date() }).where(eq(workspaceClients.id, c.id)).returning();
    await this.log(tenantId, c.id, access.userId, 'restored', `Restored ${c.name}`);
    return this.view(tenantId, restored);
  }

  // ─── Notes and activity ─────────────────────────────────────────────────────

  static async activity(tenantId: string, access: Access, clientId: string, before?: string) {
    this.needRead(access);
    await this.client(tenantId, clientId, { archived: true });
    const rows = await db.select().from(clientActivity).where(and(
      eq(clientActivity.clientId, clientId),
      eq(clientActivity.tenantId, tenantId),
      before ? lt(clientActivity.createdAt, new Date(before)) : undefined,
    )).orderBy(desc(clientActivity.createdAt)).limit(ACTIVITY_PAGE + 1);
    const people = await names(tenantId, rows.map((r) => r.actorId));
    const page = rows.slice(0, ACTIVITY_PAGE);
    return {
      items: page.map((r) => ({
        ...r,
        actorName: r.actorId ? people.get(r.actorId) ?? null : null,
        canDelete: r.kind === 'note' && (access.admin || r.actorId === access.userId),
      })),
      hasMore: rows.length > ACTIVITY_PAGE,
    };
  }

  /** Anyone who can see the client can add a note (a call, a meeting, a request) */
  static async addNote(tenantId: string, access: Access, clientId: string, body: string) {
    this.needRead(access);
    await this.client(tenantId, clientId);
    const text = body.trim();
    if (!text) throw new ClientError(400, 'note', 'Write the note first');
    const [row] = await db.insert(clientActivity).values({ tenantId, clientId, actorId: access.userId, kind: 'note', body: text }).returning();
    const people = await names(tenantId, [access.userId]);
    return { ...row, actorName: people.get(access.userId) ?? null, canDelete: true };
  }

  static async deleteNote(tenantId: string, access: Access, clientId: string, noteId: string) {
    this.needRead(access);
    const [note] = await db.select().from(clientActivity).where(and(
      eq(clientActivity.id, noteId), eq(clientActivity.clientId, clientId), eq(clientActivity.tenantId, tenantId), eq(clientActivity.kind, 'note'),
    )).limit(1);
    if (!note) throw new ClientError(404, 'not_found', 'Note not found');
    if (!access.admin && note.actorId !== access.userId) throw new ClientError(403, 'forbidden', 'You can only delete your own notes');
    await db.delete(clientActivity).where(eq(clientActivity.id, noteId));
    return { deleted: true };
  }

  // ─── Documents ──────────────────────────────────────────────────────────────

  static async documents(tenantId: string, access: Access, clientId: string) {
    this.needRead(access);
    await this.client(tenantId, clientId, { archived: true });
    const rows = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
      tx.select().from(uploads).where(and(eq(uploads.tenantId, tenantId), eq(uploads.entityType, CLIENT_DOCUMENT_ENTITY), eq(uploads.entityId, clientId)))
        .orderBy(desc(uploads.createdAt)),
    );
    const people = await names(tenantId, rows.map((r) => r.uploaderUserId));
    return rows.map((r) => ({
      id: r.id,
      name: r.originalName,
      mimeType: r.mimeType,
      size: r.size,
      uploadedAt: r.createdAt,
      uploadedBy: r.uploaderUserId ? people.get(r.uploaderUserId) ?? null : null,
    }));
  }

  static async addDocuments(tenantId: string, access: Access, clientId: string, files: Express.Multer.File[]) {
    this.needManage(access);
    await this.client(tenantId, clientId);
    if (!files.length) throw new ClientError(400, 'files', 'Choose at least one file');
    const bad = files.find((f) => !FILE_TYPES.includes(f.mimetype));
    if (bad) throw new ClientError(400, 'file_type', `"${bad.originalname}" can't be added. Use PDF, images, Word, Excel, PowerPoint, text, CSV or ZIP files.`);
    const added = [];
    for (const file of files) {
      const up = await UploadService.processUpload({ tenantId, uploaderId: access.userId, entityType: CLIENT_DOCUMENT_ENTITY, entityId: clientId, file });
      added.push(up);
      await this.log(tenantId, clientId, access.userId, 'file_added', `Added ${file.originalname}`, { uploadId: up.id, name: file.originalname });
    }
    return this.documents(tenantId, access, clientId);
  }

  private static async document(tenantId: string, clientId: string, uploadId: string) {
    const [doc] = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
      tx.select().from(uploads).where(and(
        eq(uploads.id, uploadId), eq(uploads.tenantId, tenantId), eq(uploads.entityType, CLIENT_DOCUMENT_ENTITY), eq(uploads.entityId, clientId),
      )).limit(1),
    );
    if (!doc) throw new ClientError(404, 'not_found', 'Document not found');
    return doc;
  }

  static async documentUrl(tenantId: string, access: Access, clientId: string, uploadId: string) {
    this.needRead(access);
    await this.client(tenantId, clientId, { archived: true });
    await this.document(tenantId, clientId, uploadId);
    return { url: await UploadService.getSignedDownloadUrl(tenantId, uploadId) };
  }

  static async deleteDocument(tenantId: string, access: Access, clientId: string, uploadId: string) {
    this.needManage(access);
    await this.client(tenantId, clientId);
    const doc = await this.document(tenantId, clientId, uploadId);
    try {
      await UploadService.deleteUpload(tenantId, uploadId);
    } catch (err) {
      logger.error({ err, uploadId }, '[Clients] Document delete failed');
      throw new ClientError(502, 'delete_failed', 'The document could not be deleted. Please try again.');
    }
    await this.log(tenantId, clientId, access.userId, 'file_removed', `Removed ${doc.originalName}`, { name: doc.originalName });
    return { deleted: true };
  }
}
