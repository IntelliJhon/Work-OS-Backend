import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { db } from '../../db';
import { withTenant } from '../../middleware/tenant.middleware';
import { tenants } from '../../db/schema/tenants';
import { users } from '../../db/schema/users';
import { voiceNotes } from '../../db/schema/voice_notes';
import { matchMemberName } from '../../lib/names';
import { maskPhone } from '../../lib/phone';
import { createTaskInTx, formatWorkId } from '../tasks/tasks.service';
import { WhatsAppService } from '../../services/whatsapp.service';
import { WhatsAppBotsService } from '../whatsapp-bots/whatsapp-bots.service';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { emitToTenant } from './voice-notes.controller';

/**
 * Voice/typed work is always confirmed by the sender before a task is created:
 *
 *   new note ──► doer matched ──► awaiting_confirmation ──"1"──► task created (templates sent)
 *        │                              │  "2" / a name ──► awaiting_assignee / re-confirm
 *        │                              └─ "3" ──► dismissed
 *        └─► doer missing/unknown ──► awaiting_assignee ──name──► awaiting_confirmation
 *                                              └─ choice number ──► task created
 */

type VoiceNote = typeof voiceNotes.$inferSelect;
type Member = { id: string; firstName: string; lastName: string; phone: string | null };

export type AssignmentOutcome =
  | {
      code: 'task_created';
      taskId: string;
      workId: string | null;
      assigneeName: string;
      ownerNotified: boolean;
      /** false when the employee has no WhatsApp number in Work OS or the template failed */
      employeeNotified: boolean;
      employeeHasPhone: boolean;
    }
  | {
      code: 'confirmation_required';
      title: string;
      due: string | null;
      doerName: string;
      reviewerName: string | null;
      informedNames: string[];
      isReport: boolean;
    }
  | { code: 'assignee_required'; choices: string[] }
  | { code: 'assignee_not_found'; heardName: string; choices: string[] }
  | { code: 'assignee_ambiguous'; heardName: string; choices: string[] }
  | { code: 'reply_not_understood' }
  | { code: 'cancelled' }
  | { code: 'no_pending_note' }
  | { code: 'ignored' }
  | { code: 'already_assigned' };

/** How n8n classified the owner's reply */
export type ReplyType = 'choice' | 'name' | 'other';

const PENDING_STATUSES = ['awaiting_confirmation', 'awaiting_assignee'] as const;

const fullName = (m: { firstName: string; lastName: string }) => `${m.firstName} ${m.lastName}`.trim();

const loadMembers = (tenantId: string): Promise<Member[]> =>
  withTenant(tenantId, (tx) =>
    tx
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, phone: users.phone })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt))),
  );

/** Member names for the AI prompt, so spoken names are written the way they appear in Work OS */
export const listMemberNames = async (tenantId: string): Promise<string[]> =>
  (await loadMembers(tenantId)).map(fullName).filter(Boolean);

/** First sentence of the English text, capped for a task title. */
const deriveTitle = (note: VoiceNote): string => {
  const source = (note.taskTitle || note.englishText || 'Voice note work').trim();
  const first = source.split(/(?<=[.!?])\s|\n/)[0].trim();
  return (first.length > 120 ? `${first.slice(0, 117).trimEnd()}...` : first).slice(0, 255);
};

/** "Fri, 25 Sep, 5:00 pm" from the stored local date/time (already in WORK_TIMEZONE). */
const formatDue = (dueDate: string | null, dueTime: string | null): string | null => {
  if (!dueDate) return null;
  const [y, mo, d] = dueDate.split('-').map(Number);
  const [h, mi] = (dueTime || '00:00').split(':').map(Number);
  const when = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const date = when.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (!dueTime) return date;
  return `${date}, ${when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`;
};

/** A spoken name shown as the matching member's full name when there is a clear match. */
const displayName = (heard: string, members: Member[]): string => {
  const result = matchMemberName(heard, members);
  return result.kind === 'match' ? fullName(result.member) : heard;
};

const peopleOf = (note: VoiceNote, members: Member[]) => ({
  reviewerName: note.reviewerName ? displayName(note.reviewerName, members) : null,
  informedNames: (note.informedNames || []).filter(Boolean).map((n) => displayName(n, members)),
});

/** Members named elsewhere in the note (checker/informed): likely doers when no doer was said. */
const mentionedMembers = (note: VoiceNote, members: Member[]): Member[] => {
  const found = new Map<string, Member>();
  for (const heard of [note.reviewerName, ...(note.informedNames || [])]) {
    if (!heard) continue;
    const result = matchMemberName(heard, members);
    if (result.kind === 'match') found.set(result.member.id, result.member);
  }
  return [...found.values()];
};

// Reply words, including common Malayalam/Hindi ones as typed in English letters
const normalizeReply = (reply: string) => reply.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim();
const CONFIRM = /^(1|yes|yeah|yep|y|ok|okay|k|sure|confirm(ed)?|create( it)?|go( ahead)?|done|haan|ha|han|ji|sari|seri|shari|athe|mathi|👍|✅)(\b.*)?$/i;
const CHANGE = /^(2|change|edit|another|different|ma+tt?(u|i|anam)?)(\b.*)?$/i;
const CANCEL = /^(3|no|nope|cancel|stop|don'?t|do not|venda|vendaa|veda|nahi|na|❌)(\b.*)?$/i;

async function updateNote(note: VoiceNote, patch: Partial<typeof voiceNotes.$inferInsert>) {
  const [updated] = await db
    .update(voiceNotes)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(voiceNotes.id, note.id))
    .returning();
  emitToTenant(note.tenantId, 'voice_note_updated', { id: updated.id, status: updated.status });
  return updated;
}

async function askForConfirmation(note: VoiceNote, doer: Member, members: Member[]): Promise<AssignmentOutcome> {
  const updated = await updateNote(note, {
    status: 'awaiting_confirmation',
    proposedAssigneeId: doer.id,
    assigneeCandidates: null,
  });
  return {
    code: 'confirmation_required',
    title: deriveTitle(updated),
    due: formatDue(updated.dueDate, updated.dueTime),
    doerName: fullName(doer),
    ...peopleOf(updated, members),
    isReport: updated.noteKind === 'report',
  };
}

async function askForAssignee(note: VoiceNote, heardName: string | null, offered: Member[], kind: 'required' | 'not_found' | 'ambiguous'): Promise<AssignmentOutcome> {
  await updateNote(note, {
    status: 'awaiting_assignee',
    proposedAssigneeId: null,
    assigneeName: heardName ?? note.assigneeName,
    assigneeCandidates: offered.length ? offered.map((c) => ({ id: c.id, name: fullName(c) })) : null,
  });
  const choices = offered.map(fullName);
  if (kind === 'required' || !heardName) return { code: 'assignee_required', choices };
  return kind === 'ambiguous'
    ? { code: 'assignee_ambiguous', heardName, choices }
    : { code: 'assignee_not_found', heardName, choices };
}

/** Matches a spoken/typed doer name and either proposes it for confirmation or asks to pick. */
async function proposeDoer(note: VoiceNote, heard: string | null, members: Member[]): Promise<AssignmentOutcome> {
  const name = (heard || '').trim();
  if (!name) return askForAssignee(note, null, mentionedMembers(note, members), 'required');

  const result = matchMemberName(name, members);
  if (result.kind === 'match') return askForConfirmation(note, result.member, members);
  return result.kind === 'ambiguous'
    ? askForAssignee(note, name, result.candidates, 'ambiguous')
    : askForAssignee(note, name, result.suggestions, 'not_found');
}

async function createAssignedTask(note: VoiceNote, member: Member, members: Member[]): Promise<AssignmentOutcome> {
  const [tenant] = await db
    .select({ name: tenants.name, ownerUserId: tenants.voicePhoneUserId })
    .from(tenants)
    .where(eq(tenants.id, note.tenantId))
    .limit(1);
  const actorUserId = note.senderUserId ?? tenant?.ownerUserId ?? null;
  const { reviewerName, informedNames } = peopleOf(note, members);

  const result = await withTenant(note.tenantId, async (tx) => {
    // Claim the note first so a retried request can never create a second task for it
    const [claimed] = await tx
      .update(voiceNotes)
      .set({ status: 'converted', updatedAt: new Date() })
      .where(and(eq(voiceNotes.id, note.id), isNull(voiceNotes.taskId), ne(voiceNotes.status, 'dismissed')))
      .returning({ id: voiceNotes.id });
    if (!claimed) return null;

    let ownerName = tenant?.name || 'Work OS';
    if (actorUserId) {
      const [owner] = await tx
        .select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, actorUserId))
        .limit(1);
      if (owner) ownerName = fullName(owner);
    }

    const title = deriveTitle(note);
    const language = note.detectedLanguage ? ` (${note.detectedLanguage})` : '';
    const people = [
      reviewerName ? `Checked by: ${reviewerName}` : null,
      informedNames.length ? `Informed: ${informedNames.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    const task = await createTaskInTx(tx, {
      tenantId: note.tenantId,
      actorUserId: actorUserId as string,
      actorName: ownerName,
      values: {
        projectId: null,
        name: title,
        description: `${note.englishText}${people ? `\n\n${people}` : ''}\n\nFrom a WhatsApp ${note.audioUrl ? 'voice note' : 'message'} by ${ownerName}${language}.`,
        status: 'to_do',
        assigneeId: member.id,
        customFields: {
          priority: 'medium',
          dueDate: note.dueDate || undefined,
          dueTime: note.dueTime || undefined,
          storyPoints: 0,
          subtasks: [],
          createdFrom: 'sidebar',
          source: 'voice_note',
          voiceNoteId: note.id,
          reviewerName: reviewerName || undefined,
          informedNames: informedNames.length ? informedNames : undefined,
        },
      },
    });

    await tx
      .update(voiceNotes)
      .set({ taskId: task.id, reviewedBy: actorUserId, reviewedAt: new Date(), assigneeCandidates: null, proposedAssigneeId: null })
      .where(eq(voiceNotes.id, note.id));

    return { task, title, ownerName };
  });

  if (!result) {
    // Already converted or cancelled (e.g. a retried request): nothing to create and nothing to send again
    logger.info({ voiceNoteId: note.id }, '[VoiceAssignment] Note already handled; skipping');
    return { code: 'already_assigned' };
  }

  const { task, title, ownerName } = result;
  const workId = formatWorkId(task.taskNumber) ?? task.id.slice(0, 8).toUpperCase();
  const due = formatDue(note.dueDate, note.dueTime) ?? 'Not set';
  emitToTenant(note.tenantId, 'voice_note_updated', { id: note.id, status: 'converted' });

  // Templates from the workspace's own bot (or the platform default). Owner: {{1}} work id, {{2}} employee, {{3}} work, {{4}} due.
  const wa = await WhatsAppBotsService.forTenant(note.tenantId);
  const ownerSend = await WhatsAppService.sendBodyTemplate(
    note.senderPhone,
    wa.templates.owner,
    wa.templates.lang,
    [workId, fullName(member), title, due],
    wa.sender,
  );

  // Employee: {{1}} employee first name, {{2}} owner, {{3}} work id, {{4}} work, {{5}} due.
  let employeeNotified = false;
  if (member.phone) {
    const employeeSend = await WhatsAppService.sendBodyTemplate(
      member.phone,
      wa.templates.employee,
      wa.templates.lang,
      [member.firstName, ownerName, workId, title, due],
      wa.sender,
    );
    employeeNotified = employeeSend.success;
    if (!employeeSend.success) {
      logger.warn({ taskId: task.id, to: maskPhone(member.phone), error: employeeSend.error }, '[VoiceAssignment] Employee template failed');
    }
  }
  if (!ownerSend.success) {
    logger.warn({ taskId: task.id, to: maskPhone(note.senderPhone), error: ownerSend.error }, '[VoiceAssignment] Owner template failed');
  }

  logger.info({ tenantId: note.tenantId, voiceNoteId: note.id, taskId: task.id, workId }, '[VoiceAssignment] Work created from voice note');
  return {
    code: 'task_created',
    taskId: task.id,
    workId,
    assigneeName: fullName(member),
    ownerNotified: ownerSend.success,
    employeeNotified,
    employeeHasPhone: !!member.phone,
  };
}

export class VoiceAssignmentService {
  /** A freshly ingested note: propose the doer Gemini extracted (never creates a task directly). */
  static async proposeNewNote(note: VoiceNote): Promise<AssignmentOutcome> {
    const members = await loadMembers(note.tenantId);
    return proposeDoer(note, note.assigneeName, members);
  }

  /**
   * The owner replied on WhatsApp. Applies to the most recent note of this workspace that is
   * waiting for them (within the window). `quiet`: no "send a voice note" nudge when nothing is waiting
   * (used for chit-chat such as "thanks").
   */
  static async handleReply(tenantId: string, reply: string, replyType: ReplyType = 'other', quiet = false): Promise<AssignmentOutcome> {
    const since = new Date(Date.now() - env.VOICE_ASSIGNEE_WINDOW_MINUTES * 60 * 1000);
    const [note] = await db
      .select()
      .from(voiceNotes)
      .where(and(
        eq(voiceNotes.tenantId, tenantId),
        inArray(voiceNotes.status, [...PENDING_STATUSES]),
        gt(voiceNotes.updatedAt, since),
      ))
      .orderBy(desc(voiceNotes.updatedAt))
      .limit(1);
    if (!note) return quiet ? { code: 'ignored' } : { code: 'no_pending_note' };

    const text = normalizeReply(reply);
    const members = await loadMembers(tenantId);

    if (note.status === 'awaiting_confirmation') {
      if (CONFIRM.test(text) && replyType !== 'name') {
        const doer = members.find((m) => m.id === note.proposedAssigneeId);
        if (doer) return createAssignedTask(note, doer, members);
        return askForAssignee(note, null, mentionedMembers(note, members), 'required'); // doer was removed meanwhile
      }
      if (CANCEL.test(text) && replyType !== 'name') {
        await updateNote(note, { status: 'dismissed', proposedAssigneeId: null, assigneeCandidates: null });
        return { code: 'cancelled' };
      }
      if (CHANGE.test(text) && replyType !== 'name') {
        return askForAssignee(note, null, [], 'required');
      }
      // A name instead of 1/2/3: use it as the new doer, and confirm again
      if (replyType === 'name') return proposeDoer(note, reply, members);
      return { code: 'reply_not_understood' };
    }

    // awaiting_assignee
    if (CANCEL.test(text) && !/^\d+$/.test(text)) {
      await updateNote(note, { status: 'dismissed', proposedAssigneeId: null, assigneeCandidates: null });
      return { code: 'cancelled' };
    }
    // Picking a number from the offered list is an explicit choice of an exact member: create directly
    const choice = /^(\d{1,2})$/.exec(text);
    if (choice && note.assigneeCandidates?.length) {
      const picked = note.assigneeCandidates[Number(choice[1]) - 1];
      const doer = picked && members.find((m) => m.id === picked.id);
      if (doer) return createAssignedTask(note, doer, members);
    }
    // A number that isn't one of the choices: repeat the question
    if (choice) return { code: 'assignee_required', choices: (note.assigneeCandidates || []).map((c) => c.name) };
    // A typed or spoken name: match it and show the result for confirmation
    return proposeDoer(note, reply, members);
  }
}
