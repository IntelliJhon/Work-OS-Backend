import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { chatGroupMembers, chatGroups, chatMessages, type ChatAttachment } from '../../db/schema/chat_groups';
import { roles } from '../../db/schema/roles';
import { uploads } from '../../db/schema/uploads';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadService } from '../uploads/upload.service';
import { getPlayableAudioUrl } from '../uploads/cloudinary';
import { getIoInstance } from '../../socket/socketServer';
import { getUserRoom } from '../../socket/tenantRooms';
import { logger } from '../../config/logger';
import { createTaskInTx, formatWorkId } from '../tasks/tasks.service';
import { SectionsService } from '../sections/sections.service';
import { allows, roleAccess } from '../sections/role-access';

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
export interface Person { id: string; firstName: string; lastName: string; workspaceAdmin: boolean; canCreate: boolean }

const MAX_BODY = 4000;
const PAGE = 50;
export const FILE_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/zip', 'application/x-zip-compressed',
  // Audio: voice messages recorded in the browser (Android WebM/Ogg, iPhone MP4/AAC) and shared audio files
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/wav', 'audio/x-wav',
];

/** 'audio/webm;codecs=opus' → 'audio/webm' (browsers add codec details to recordings) */
export const baseType = (mime: string) => mime.split(';')[0].trim().toLowerCase();

/** A voice message can be at most this long (the recorder stops itself at 5 minutes) */
export const MAX_VOICE_MS = 5 * 60_000 + 5_000;
const VOICE_EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

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

  /** For other group features (e.g. summaries): the same membership check */
  static async memberContext(tenantId: string, actorId: string, groupId: string) {
    return this.access(tenantId, actorId, groupId);
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

  private static view(m: Message, everyone: Person[], replies: Map<string, Message> = new Map()) {
    const sender = everyone.find((p) => p.id === m.senderId);
    const quoted = m.replyToId ? replies.get(m.replyToId) : undefined;
    const quotedSender = quoted ? everyone.find((p) => p.id === quoted.senderId) : undefined;
    return {
      id: m.id,
      groupId: m.groupId,
      senderId: m.senderId,
      senderName: sender ? fullName(sender) : 'Former member',
      body: m.deletedAt ? null : m.body,
      mentions: m.deletedAt ? [] : m.mentions,
      attachments: m.deletedAt ? [] : m.attachments,
      deleted: !!m.deletedAt,
      pinnedAt: m.deletedAt ? null : m.pinnedAt,
      replyTo: !m.replyToId || m.deletedAt ? null : quoted ? {
        id: quoted.id,
        senderName: quotedSender ? fullName(quotedSender) : 'Former member',
        body: quoted.deletedAt ? null : (quoted.body ?? '').slice(0, 200),
        attachmentName: quoted.deletedAt ? null : quoted.attachments[0]?.name ?? null,
        deleted: !!quoted.deletedAt,
      } : { id: m.replyToId, senderName: '', body: null, attachmentName: null, deleted: true },
      createdAt: m.createdAt,
    };
  }

  /** The messages that a set of messages reply to */
  private static async repliesFor(groupId: string, list: Message[]) {
    const ids = [...new Set(list.map((m) => m.replyToId).filter((x): x is string => !!x))];
    if (!ids.length) return new Map<string, Message>();
    const rows = await db.select().from(chatMessages).where(and(eq(chatMessages.groupId, groupId), inArray(chatMessages.id, ids)));
    return new Map(rows.map((x) => [x.id, x]));
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
        return p ? { id: p.id, name: fullName(p), role: m.role, joinedAt: m.joinedAt, lastReadAt: m.lastReadAt } : null;
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
    const page = rows.slice(0, PAGE).reverse();
    const replies = await this.repliesFor(groupId, page);
    return { messages: page.map((m) => this.view(m, everyone, replies)), more };
  }

  static async send(tenantId: string, actorId: string, groupId: string, input: { body?: string; mentions?: string[]; files?: Express.Multer.File[]; replyToId?: string | null; voiceDurationMs?: number | null }) {
    const { g, list, everyone } = await this.access(tenantId, actorId, groupId);
    const body = (input.body ?? '').trim();
    const files = input.files ?? [];
    if (!body && !files.length) throw new GroupError(400, 'empty', 'Write a message or attach a file');
    if (body.length > MAX_BODY) throw new GroupError(400, 'too_long', `A message can be at most ${MAX_BODY} characters`);
    const bad = files.find((f) => !FILE_TYPES.includes(baseType(f.mimetype)));
    if (bad) throw new GroupError(400, 'file_type', `${bad.originalname}: this file type can't be shared`);
    const voice = input.voiceDurationMs != null;
    if (voice) {
      if (files.length !== 1 || !baseType(files[0].mimetype).startsWith('audio/')) throw new GroupError(400, 'voice', 'A voice message is one recording');
      if (!(input.voiceDurationMs! > 0) || input.voiceDurationMs! > MAX_VOICE_MS) throw new GroupError(400, 'voice_length', 'A voice message can be at most 5 minutes');
    }

    const attachments: ChatAttachment[] = [];
    for (const file of files) {
      const up = await UploadService.processUpload({ tenantId, uploaderId: actorId, entityType: 'GROUP', entityId: groupId, file });
      const mimeType = baseType(file.mimetype);
      attachments.push(voice
        ? { uploadId: up.id, name: `Voice message.${VOICE_EXT[mimeType] ?? 'webm'}`, mimeType, size: file.size, voice: true, durationMs: Math.round(input.voiceDurationMs!) }
        : { uploadId: up.id, name: file.originalname, mimeType, size: file.size });
    }
    let replyToId: string | null = null;
    if (input.replyToId) {
      const [quoted] = await db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.id, input.replyToId), eq(chatMessages.groupId, groupId))).limit(1);
      if (!quoted) throw new GroupError(400, 'reply_to', 'The message you are replying to is not in this group');
      replyToId = quoted.id;
    }
    const memberIds = list.map((m) => m.userId);
    const mentions = [...new Set(input.mentions ?? [])].filter((id) => id !== actorId && memberIds.includes(id));
    const now = new Date();
    const [m] = await db.insert(chatMessages).values({ tenantId, groupId, senderId: actorId, body: body || null, mentions, attachments, replyToId, createdAt: now }).returning();
    await db.update(chatGroups).set({ lastMessageAt: now }).where(eq(chatGroups.id, groupId));
    await db.update(chatGroupMembers).set({ lastReadAt: now }).where(and(eq(chatGroupMembers.groupId, groupId), eq(chatGroupMembers.userId, actorId)));

    const message = this.view(m, everyone, await this.repliesFor(groupId, [m]));
    pushTo(tenantId, memberIds, 'group_message', { groupId, message });

    if (mentions.length) {
      const sender = everyone.find((p) => p.id === actorId);
      await withTenant(tenantId, async (tx) => {
        for (const userId of mentions) {
          await NotificationsService.notify({
            tenantId, recipientUserId: userId, actorUserId: actorId, type: 'group_mention', entityType: 'group', entityId: groupId,
            title: `${sender ? fullName(sender) : 'Someone'} mentioned you in ${g.name}`,
            message: (body || attachments.map((a) => (a.voice ? 'Voice message' : a.name)).join(', ')).slice(0, 200), priority: 'info',
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
    const { list } = await this.access(tenantId, actorId, groupId);
    const lastReadAt = new Date();
    await db.update(chatGroupMembers).set({ lastReadAt }).where(and(eq(chatGroupMembers.groupId, groupId), eq(chatGroupMembers.userId, actorId)));
    // Everyone in the group: their "Seen by" counts change
    pushTo(tenantId, list.map((m) => m.userId), 'group_read', { groupId, userId: actorId, lastReadAt });
    return { read: groupId };
  }

  // ─── Pins, search, message → task ──────────────────────────────────────────────

  /** Group admins pin or unpin a message */
  static async setPinned(tenantId: string, actorId: string, groupId: string, messageId: string, pinned: boolean) {
    const { list, canManage } = await this.access(tenantId, actorId, groupId);
    if (!canManage) throw new GroupError(403, 'forbidden', 'Only group admins can pin messages');
    const [m] = await db.select().from(chatMessages).where(and(eq(chatMessages.id, messageId), eq(chatMessages.groupId, groupId))).limit(1);
    if (!m || m.deletedAt) throw new GroupError(404, 'not_found', 'Message not found');
    await db.update(chatMessages).set(pinned ? { pinnedAt: new Date(), pinnedBy: actorId } : { pinnedAt: null, pinnedBy: null }).where(eq(chatMessages.id, messageId));
    pushTo(tenantId, list.map((x) => x.userId), 'group_pins', { groupId });
    return { messageId, pinned };
  }

  static async pinned(tenantId: string, actorId: string, groupId: string) {
    const { everyone } = await this.access(tenantId, actorId, groupId);
    const rows = await db.select().from(chatMessages)
      .where(and(eq(chatMessages.groupId, groupId), isNotNull(chatMessages.pinnedAt), isNull(chatMessages.deletedAt)))
      .orderBy(desc(chatMessages.pinnedAt)).limit(50);
    return rows.map((m) => this.view(m, everyone));
  }

  /** Messages whose text or file names contain the words */
  static async search(tenantId: string, actorId: string, groupId: string, query: string) {
    const { everyone } = await this.access(tenantId, actorId, groupId);
    const q = query.trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db.select().from(chatMessages)
      .where(and(eq(chatMessages.groupId, groupId), isNull(chatMessages.deletedAt), or(ilike(chatMessages.body, like), sql`${chatMessages.attachments}::text ilike ${like}`)))
      .orderBy(desc(chatMessages.createdAt)).limit(50);
    return rows.map((m) => this.view(m, everyone));
  }

  /** Turns a message (or a summary's action item) into a task for a workspace member */
  static async createTask(
    tenantId: string,
    actorId: string,
    actorRoleId: string,
    groupId: string,
    input: { messageId?: string | null; name: string; assigneeId: string; dueDate?: string | null },
  ) {
    const { g, everyone } = await this.access(tenantId, actorId, groupId);
    if (!(await SectionsService.isEnabled(tenantId, 'tasks'))) throw new GroupError(403, 'tasks_off', 'Tasks are turned off for this workspace');
    if (!allows(await roleAccess(tenantId, actorRoleId), 'task.create')) throw new GroupError(403, 'forbidden', 'Your role cannot create tasks');
    const assignee = everyone.find((p) => p.id === input.assigneeId);
    if (!assignee) throw new GroupError(400, 'assignee', 'Choose someone from your workspace');
    const name = input.name.trim().slice(0, 255);
    if (name.length < 2) throw new GroupError(400, 'name', 'Give the task a name');
    let source: Message | undefined;
    if (input.messageId) {
      [source] = await db.select().from(chatMessages).where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.groupId, groupId))).limit(1);
      if (!source) throw new GroupError(404, 'not_found', 'Message not found');
    }
    const actor = everyone.find((p) => p.id === actorId)!;
    const sourceSender = source ? everyone.find((p) => p.id === source!.senderId) : undefined;
    const task = await withTenant(tenantId, (tx) => createTaskInTx(tx, {
      tenantId,
      actorUserId: actorId,
      actorName: fullName(actor),
      values: {
        projectId: null,
        name,
        description: source?.body
          ? `From the group "${g.name}"${sourceSender ? `, message by ${fullName(sourceSender)}` : ''}:\n\n${source.body}`
          : `From the group "${g.name}".`,
        status: 'to_do',
        assigneeId: assignee.id,
        customFields: { priority: 'medium', dueDate: input.dueDate || undefined, createdFrom: 'sidebar', fromGroup: { groupId, messageId: source?.id ?? null } },
      },
    }));
    logger.info({ tenantId, groupId, taskId: task.id }, '[Groups] Task created from the group');
    return { id: task.id, workId: formatWorkId(task.taskNumber), name: task.name, assigneeName: fullName(assignee) };
  }

  /** A short-lived link to a shared file (members only) */
  static async fileUrl(tenantId: string, actorId: string, groupId: string, uploadId: string) {
    await this.access(tenantId, actorId, groupId);
    const [f] = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
      tx.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.tenantId, tenantId), eq(uploads.entityType, 'GROUP'), eq(uploads.entityId, groupId))),
    );
    if (!f) throw new GroupError(404, 'not_found', 'File not found');
    // Audio plays in the chat: a link that works in every browser
    if (baseType(f.mimeType).startsWith('audio/')) return { url: getPlayableAudioUrl(f.storageKey), playable: true };
    return { url: await UploadService.getSignedDownloadUrl(tenantId, uploadId) };
  }

  /** Everyone in the workspace, to pick members from */
  static async directory(tenantId: string) {
    return (await people(tenantId)).map((p) => ({ id: p.id, name: fullName(p) })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

