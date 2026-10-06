import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { chatGroupMembers, chatGroups, chatMessages, type ChatAttachment } from '../../db/schema/chat_groups';
import { roles } from '../../db/schema/roles';
import { uploads } from '../../db/schema/uploads';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadService } from '../uploads/upload.service';
import { getIoInstance } from '../../socket/socketServer';
import { getUserRoom } from '../../socket/tenantRooms';
import { logger } from '../../config/logger';

/**
 * Company group chats, like WhatsApp groups. Admins and Project Managers (groups.create) create a group and add
 * members; members message each other with text, @mentions and files. A group's admins (and workspace Admins)
 * manage its name and members. Only members can read a group. New messages are pushed live to each member's own
 * socket room; sending always goes through this API.
 */

export class GroupError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type Group = typeof chatGroups.$inferSelect;
type Message = typeof chatMessages.$inferSelect;
interface Person { id: string; firstName: string; lastName: string; workspaceAdmin: boolean; canCreate: boolean }

const MAX_BODY = 4000;
const PAGE = 50;
export const FILE_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/zip', 'application/x-zip-compressed',
];

const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

async function people(tenantId: string): Promise<Person[]> {
  const rows = await withTenant<{ id: string; firstName: string; lastName: string; roleName: string; permissions: Record<string, boolean> }[]>(tenantId, (tx) =>
    tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, roleName: roles.name, permissions: roles.permissions })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt))),
  );
  return rows.map((r) => {
    const admin = r.roleName === 'Admin' || r.permissions?.admin === true;
    return { id: r.id, firstName: r.firstName, lastName: r.lastName, workspaceAdmin: admin, canCreate: admin || r.permissions?.['groups.create'] === true };
  });
}

/** Pushes an event to each listed member's own socket room (best effort) */
function pushTo(tenantId: string, userIds: string[], event: string, payload: unknown) {
  try {
    const io = getIoInstance();
    for (const id of userIds) io.to(getUserRoom(tenantId, id)).emit(event, payload);
  } catch {
    // Live update only; clients also refetch
  }
}

export class GroupsService {
  // ─── Access ───────────────────────────────────────────────────────────────────

  private static async group(tenantId: string, groupId: string): Promise<Group> {
    const [g] = await db.select().from(chatGroups).where(and(eq(chatGroups.id, groupId), eq(chatGroups.tenantId, tenantId), isNull(chatGroups.archivedAt))).limit(1);
    if (!g) throw new GroupError(404, 'not_found', 'Group not found');
    return g;
  }

  private static async memberships(groupId: string) {
    return db.select().from(chatGroupMembers).where(eq(chatGroupMembers.groupId, groupId));
  }

  /** The group, its members and the actor's place in it; 404 for non-members */
  private static async access(tenantId: string, actorId: string, groupId: string) {
    const [g, list, everyone] = await Promise.all([this.group(tenantId, groupId), this.memberships(groupId), people(tenantId)]);
    const me = list.find((m) => m.userId === actorId);
    if (!me) throw new GroupError(404, 'not_found', 'Group not found');
    const actor = everyone.find((p) => p.id === actorId);
    const canManage = me.role === 'admin' || !!actor?.workspaceAdmin;
    return { g, list, me, everyone, canManage };
  }

  private static view(m: Message, everyone: Person[]) {
    const sender = everyone.find((p) => p.id === m.senderId);
    return {
      id: m.id,
      groupId: m.groupId,
      senderId: m.senderId,
      senderName: sender ? fullName(sender) : 'Former member',
      body: m.deletedAt ? null : m.body,
      mentions: m.deletedAt ? [] : m.mentions,
      attachments: m.deletedAt ? [] : m.attachments,
      deleted: !!m.deletedAt,
      createdAt: m.createdAt,
    };
  }

  // ─── Groups ───────────────────────────────────────────────────────────────────

  /** The groups the person is in, newest activity first, with unread counts and the last message */
  static async list(tenantId: string, actorId: string) {
    const everyone = await people(tenantId);
    const actor = everyone.find((p) => p.id === actorId);
    const rows = await db
      .select({
        id: chatGroups.id, name: chatGroups.name, description: chatGroups.description, lastMessageAt: chatGroups.lastMessageAt,
        createdAt: chatGroups.createdAt, role: chatGroupMembers.role, lastReadAt: chatGroupMembers.lastReadAt,
      })
      .from(chatGroups)
      .innerJoin(chatGroupMembers, and(eq(chatGroupMembers.groupId, chatGroups.id), eq(chatGroupMembers.userId, actorId)))
      .where(and(eq(chatGroups.tenantId, tenantId), isNull(chatGroups.archivedAt)))
      .orderBy(desc(sql`coalesce(${chatGroups.lastMessageAt}, ${chatGroups.createdAt})`));
    const groups = await Promise.all(rows.map(async (g) => {
      const [[unread], [last], [count]] = await Promise.all([
        db.select({ n: sql<number>`count(*)::int` }).from(chatMessages).where(and(
          eq(chatMessages.groupId, g.id), sql`${chatMessages.createdAt} > ${g.lastReadAt}`, isNull(chatMessages.deletedAt),
          sql`${chatMessages.senderId} is distinct from ${actorId}`,
        )),
        db.select().from(chatMessages).where(eq(chatMessages.groupId, g.id)).orderBy(desc(chatMessages.createdAt)).limit(1),
        db.select({ n: sql<number>`count(*)::int` }).from(chatGroupMembers).where(eq(chatGroupMembers.groupId, g.id)),
      ]);
      return { ...g, unread: unread?.n ?? 0, members: count?.n ?? 0, lastMessage: last ? this.view(last, everyone) : null };
    }));
    return { groups, canCreate: !!actor?.canCreate };
  }

  static async unreadTotal(tenantId: string, actorId: string) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(chatMessages)
      .innerJoin(chatGroupMembers, and(eq(chatGroupMembers.groupId, chatMessages.groupId), eq(chatGroupMembers.userId, actorId)))
      .innerJoin(chatGroups, and(eq(chatGroups.id, chatMessages.groupId), isNull(chatGroups.archivedAt)))
      .where(and(
        eq(chatMessages.tenantId, tenantId), isNull(chatMessages.deletedAt),
        sql`${chatMessages.createdAt} > ${chatGroupMembers.lastReadAt}`, sql`${chatMessages.senderId} is distinct from ${actorId}`,
      ));
    return { unread: row?.n ?? 0 };
  }

  static async get(tenantId: string, actorId: string, groupId: string) {
    const { g, list, me, everyone, canManage } = await this.access(tenantId, actorId, groupId);
    const members = list
      .map((m) => {
        const p = everyone.find((x) => x.id === m.userId);
        return p ? { id: p.id, name: fullName(p), role: m.role, joinedAt: m.joinedAt } : null;
      })
      .filter((m): m is NonNullable<typeof m> => !!m)
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1));
    return { ...g, myRole: me.role, canManage, members };
  }

  static async create(tenantId: string, actorId: string, input: { name: string; description?: string | null; memberIds: string[] }) {
    const everyone = await people(tenantId);
    const actor = everyone.find((p) => p.id === actorId);
    if (!actor?.canCreate) throw new GroupError(403, 'forbidden', 'Only Admins and Project Managers can create groups');
    const name = input.name.trim();
    if (name.length < 2) throw new GroupError(400, 'name', 'Give the group a name');
    const memberIds = [...new Set(input.memberIds)].filter((id) => id !== actorId && everyone.some((p) => p.id === id));
    const [g] = await db.insert(chatGroups).values({ tenantId, name, description: input.description?.trim() || null, createdBy: actorId }).returning();
    await db.insert(chatGroupMembers).values([
      { groupId: g.id, userId: actorId, tenantId, role: 'admin', addedBy: actorId },
      ...memberIds.map((userId) => ({ groupId: g.id, userId, tenantId, role: 'member' as const, addedBy: actorId })),
    ]);
    await this.tellAdded(tenantId, g, actor, memberIds);
    pushTo(tenantId, [actorId, ...memberIds], 'group_updated', { groupId: g.id });
    logger.info({ tenantId, groupId: g.id, members: memberIds.length + 1 }, '[Groups] Created');
    return this.get(tenantId, actorId, g.id);
  }

  static async update(tenantId: string, actorId: string, groupId: string, input: { name?: string; description?: string | null }) {
    const { g, list, canManage } = await this.access(tenantId, actorId, groupId);
    if (!canManage) throw new GroupError(403, 'forbidden', 'Only group admins can change the group');
    const name = input.name?.trim();
    if (name !== undefined && name.length < 2) throw new GroupError(400, 'name', 'Give the group a name');
    await db.update(chatGroups).set({
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      updatedAt: new Date(),
    }).where(eq(chatGroups.id, g.id));
    pushTo(tenantId, list.map((m) => m.userId), 'group_updated', { groupId });
    return this.get(tenantId, actorId, groupId);
  }

  static async addMembers(tenantId: string, actorId: string, groupId: string, userIds: string[]) {
    const { g, list, everyone, canManage } = await this.access(tenantId, actorId, groupId);
    if (!canManage) throw new GroupError(403, 'forbidden', 'Only group admins can add members');
    const fresh = [...new Set(userIds)].filter((id) => everyone.some((p) => p.id === id) && !list.some((m) => m.userId === id));
    if (fresh.length) {
      await db.insert(chatGroupMembers)
        .values(fresh.map((userId) => ({ groupId, userId, tenantId, role: 'member' as const, addedBy: actorId })))
        .onConflictDoNothing();
      await this.tellAdded(tenantId, g, everyone.find((p) => p.id === actorId)!, fresh);
    }
    pushTo(tenantId, [...list.map((m) => m.userId), ...fresh], 'group_updated', { groupId });
    return this.get(tenantId, actorId, groupId);
  }

  /** Removes a member (group admins), or leaves the group (anyone, for themselves) */
  static async removeMember(tenantId: string, actorId: string, groupId: string, userId: string) {
    const { list, canManage } = await this.access(tenantId, actorId, groupId);
    if (userId !== actorId && !canManage) throw new GroupError(403, 'forbidden', 'Only group admins can remove members');
    const target = list.find((m) => m.userId === userId);
    if (!target) throw new GroupError(404, 'not_member', 'This person is not in the group');
    const admins = list.filter((m) => m.role === 'admin');
    await db.delete(chatGroupMembers).where(and(eq(chatGroupMembers.groupId, groupId), eq(chatGroupMembers.userId, userId)));
    // Never leave a group without an admin: the longest-standing member takes over
    if (target.role === 'admin' && admins.length === 1) {
      const next = list.filter((m) => m.userId !== userId).sort((a, b) => +a.joinedAt - +b.joinedAt)[0];
      if (next) await db.update(chatGroupMembers).set({ role: 'admin' }).where(and(eq(chatGroupMembers.groupId, groupId), eq(chatGroupMembers.userId, next.userId)));
    }
    pushTo(tenantId, list.map((m) => m.userId), 'group_updated', { groupId });
    return { removed: userId };
  }

  static async setRole(tenantId: string, actorId: string, groupId: string, userId: string, role: 'admin' | 'member') {
    const { list, canManage } = await this.access(tenantId, actorId, groupId);
    if (!canManage) throw new GroupError(403, 'forbidden', 'Only group admins can change roles');
    const target = list.find((m) => m.userId === userId);
    if (!target) throw new GroupError(404, 'not_member', 'This person is not in the group');
    if (role === 'member' && target.role === 'admin' && list.filter((m) => m.role === 'admin').length === 1) {
      throw new GroupError(400, 'last_admin', 'A group needs at least one admin');
    }
    await db.update(chatGroupMembers).set({ role }).where(and(eq(chatGroupMembers.groupId, groupId), eq(chatGroupMembers.userId, userId)));
    pushTo(tenantId, list.map((m) => m.userId), 'group_updated', { groupId });
    return this.get(tenantId, actorId, groupId);
  }

  static async archive(tenantId: string, actorId: string, groupId: string) {
    const { list, canManage } = await this.access(tenantId, actorId, groupId);
    if (!canManage) throw new GroupError(403, 'forbidden', 'Only group admins can delete the group');
    await db.update(chatGroups).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(chatGroups.id, groupId));
    pushTo(tenantId, list.map((m) => m.userId), 'group_updated', { groupId, archived: true });
    return { archived: groupId };
  }

  private static async tellAdded(tenantId: string, g: Group, by: Person, userIds: string[]) {
    if (!userIds.length) return;
    await withTenant(tenantId, async (tx) => {
      for (const userId of userIds) {
        await NotificationsService.notify({
          tenantId, recipientUserId: userId, actorUserId: by.id, type: 'group_added', entityType: 'group', entityId: g.id,
          title: `You were added to ${g.name}`, message: `${fullName(by)} added you to the group.`, priority: 'info',
        }, tx);
      }
    }).catch((err) => logger.warn({ err }, '[Groups] Added notification failed'));
  }

  // ─── Messages ─────────────────────────────────────────────────────────────────

  /** Messages, oldest first; pass `before` (a message time) to load earlier ones */
  static async messages(tenantId: string, actorId: string, groupId: string, before?: string) {
    const { everyone } = await this.access(tenantId, actorId, groupId);
    const rows = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.groupId, groupId), before ? lt(chatMessages.createdAt, new Date(before)) : sql`true`))
      .orderBy(desc(chatMessages.createdAt))
      .limit(PAGE + 1);
    const more = rows.length > PAGE;
    return { messages: rows.slice(0, PAGE).reverse().map((m) => this.view(m, everyone)), more };
  }

  static async send(tenantId: string, actorId: string, groupId: string, input: { body?: string; mentions?: string[]; files?: Express.Multer.File[] }) {
    const { g, list, everyone } = await this.access(tenantId, actorId, groupId);
    const body = (input.body ?? '').trim();
    const files = input.files ?? [];
    if (!body && !files.length) throw new GroupError(400, 'empty', 'Write a message or attach a file');
    if (body.length > MAX_BODY) throw new GroupError(400, 'too_long', `A message can be at most ${MAX_BODY} characters`);
    const bad = files.find((f) => !FILE_TYPES.includes(f.mimetype));
    if (bad) throw new GroupError(400, 'file_type', `${bad.originalname}: this file type can't be shared`);

    const attachments: ChatAttachment[] = [];
    for (const file of files) {
      const up = await UploadService.processUpload({ tenantId, uploaderId: actorId, entityType: 'GROUP', entityId: groupId, file });
      attachments.push({ uploadId: up.id, name: file.originalname, mimeType: file.mimetype, size: file.size });
    }
    const memberIds = list.map((m) => m.userId);
    const mentions = [...new Set(input.mentions ?? [])].filter((id) => id !== actorId && memberIds.includes(id));
    const now = new Date();
    const [m] = await db.insert(chatMessages).values({ tenantId, groupId, senderId: actorId, body: body || null, mentions, attachments, createdAt: now }).returning();
    await db.update(chatGroups).set({ lastMessageAt: now }).where(eq(chatGroups.id, groupId));
    await db.update(chatGroupMembers).set({ lastReadAt: now }).where(and(eq(chatGroupMembers.groupId, groupId), eq(chatGroupMembers.userId, actorId)));

    const message = this.view(m, everyone);
    pushTo(tenantId, memberIds, 'group_message', { groupId, message });

    if (mentions.length) {
      const sender = everyone.find((p) => p.id === actorId);
      await withTenant(tenantId, async (tx) => {
        for (const userId of mentions) {
          await NotificationsService.notify({
            tenantId, recipientUserId: userId, actorUserId: actorId, type: 'group_mention', entityType: 'group', entityId: groupId,
            title: `${sender ? fullName(sender) : 'Someone'} mentioned you in ${g.name}`,
            message: (body || attachments.map((a) => a.name).join(', ')).slice(0, 200), priority: 'info',
          }, tx);
        }
      }).catch((err) => logger.warn({ err }, '[Groups] Mention notification failed'));
    }
    return message;
  }

  /** The sender (or a group admin) deletes a message; it shows as "This message was deleted" */
  static async deleteMessage(tenantId: string, actorId: string, groupId: string, messageId: string) {
    const { list, canManage } = await this.access(tenantId, actorId, groupId);
    const [m] = await db.select().from(chatMessages).where(and(eq(chatMessages.id, messageId), eq(chatMessages.groupId, groupId))).limit(1);
    if (!m || m.deletedAt) throw new GroupError(404, 'not_found', 'Message not found');
    if (m.senderId !== actorId && !canManage) throw new GroupError(403, 'forbidden', 'You can only delete your own messages');
    await db.update(chatMessages).set({ deletedAt: new Date() }).where(eq(chatMessages.id, messageId));
    pushTo(tenantId, list.map((x) => x.userId), 'group_message_deleted', { groupId, messageId });
    return { deleted: messageId };
  }

  static async markRead(tenantId: string, actorId: string, groupId: string) {
    await this.access(tenantId, actorId, groupId);
    await db.update(chatGroupMembers).set({ lastReadAt: new Date() }).where(and(eq(chatGroupMembers.groupId, groupId), eq(chatGroupMembers.userId, actorId)));
    pushTo(tenantId, [actorId], 'group_read', { groupId });
    return { read: groupId };
  }

  /** A short-lived link to a shared file (members only) */
  static async fileUrl(tenantId: string, actorId: string, groupId: string, uploadId: string) {
    await this.access(tenantId, actorId, groupId);
    const [f] = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
      tx.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.tenantId, tenantId), eq(uploads.entityType, 'GROUP'), eq(uploads.entityId, groupId))),
    );
    if (!f) throw new GroupError(404, 'not_found', 'File not found');
    return { url: await UploadService.getSignedDownloadUrl(tenantId, uploadId) };
  }

  /** Everyone in the workspace, to pick members from */
  static async directory(tenantId: string) {
    return (await people(tenantId)).map((p) => ({ id: p.id, name: fullName(p) })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

