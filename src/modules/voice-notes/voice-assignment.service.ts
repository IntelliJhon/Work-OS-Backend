import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { withTenant } from '../../middleware/tenant.middleware';
import { tenants } from '../../db/schema/tenants';
import { users } from '../../db/schema/users';
import { voiceNotes } from '../../db/schema/voice_notes';
import { matchMemberName } from '../../lib/names';
import { maskPhone } from '../../lib/phone';
import { createTaskInTx, formatWorkId } from '../tasks/tasks.service';
import { WhatsAppService } from '../../services/whatsapp.service';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { emitToTenant } from './voice-notes.controller';

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
  | { code: 'assignee_required' }
  | { code: 'assignee_not_found'; heardName: string; choices: string[] }
  | { code: 'assignee_ambiguous'; heardName: string; choices: string[] }
  | { code: 'no_pending_note' }
  | { code: 'already_assigned' };

const fullName = (m: { firstName: string; lastName: string }) => `${m.firstName} ${m.lastName}`.trim();

const loadMembers = (tenantId: string): Promise<Member[]> =>
  withTenant(tenantId, (tx) =>
    tx
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, phone: users.phone })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt))),
  );

/** First sentence of the English text, capped for a task title. */
const deriveTitle = (note: VoiceNote): string => {
  const source = (note.taskTitle || note.englishText || 'Voice note work').trim();
  const first = source.split(/(?<=[.!?])\s|\n/)[0].trim();
  return (first.length > 120 ? `${first.slice(0, 117).trimEnd()}...` : first).slice(0, 255);
};

/** "Fri, 25 Sep, 5:00 pm" from the stored local date/time (already in WORK_TIMEZONE). */
const formatDue = (dueDate: string | null, dueTime: string | null): string => {
  if (!dueDate) return 'Not set';
  const [y, mo, d] = dueDate.split('-').map(Number);
  const [h, mi] = (dueTime || '00:00').split(':').map(Number);
  const when = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const date = when.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (!dueTime) return date;
  return `${date}, ${when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`;
};

async function markAwaitingAssignee(note: VoiceNote, heardName: string | null, candidates: Member[]) {
  const [updated] = await db
    .update(voiceNotes)
    .set({
      status: 'awaiting_assignee',
      assigneeName: heardName ?? note.assigneeName,
      assigneeCandidates: candidates.length ? candidates.map((c) => ({ id: c.id, name: fullName(c) })) : null,
      updatedAt: new Date(),
    })
    .where(eq(voiceNotes.id, note.id))
    .returning();
  emitToTenant(note.tenantId, 'voice_note_updated', { id: updated.id, status: updated.status });
}

async function createAssignedTask(note: VoiceNote, member: Member): Promise<AssignmentOutcome> {
  const [tenant] = await db
    .select({ name: tenants.name, ownerUserId: tenants.voicePhoneUserId })
    .from(tenants)
    .where(eq(tenants.id, note.tenantId))
    .limit(1);
  const actorUserId = note.senderUserId ?? tenant?.ownerUserId ?? null;

  const result = await withTenant(note.tenantId, async (tx) => {
    // Claim the note first so a retried webhook can never create a second task for it
    const [claimed] = await tx
      .update(voiceNotes)
      .set({ status: 'converted', updatedAt: new Date() })
      .where(and(eq(voiceNotes.id, note.id), isNull(voiceNotes.taskId)))
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
    const task = await createTaskInTx(tx, {
      tenantId: note.tenantId,
      actorUserId: actorUserId as string,
      actorName: ownerName,
      values: {
        projectId: null,
        name: title,
        description: `${note.englishText}\n\nFrom a WhatsApp voice note by ${ownerName}${language}.`,
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
        },
      },
    });

    await tx
      .update(voiceNotes)
      .set({ taskId: task.id, reviewedBy: actorUserId, reviewedAt: new Date(), assigneeCandidates: null })
      .where(eq(voiceNotes.id, note.id));

    return { task, title, ownerName };
  });

  if (!result) {
    // Already converted (e.g. a retried request): nothing to create and nothing to send again
    logger.info({ voiceNoteId: note.id }, '[VoiceAssignment] Note already converted; skipping');
    return { code: 'already_assigned' };
  }

  const { task, title, ownerName } = result;
  const workId = formatWorkId(task.taskNumber) ?? task.id.slice(0, 8).toUpperCase();
  const due = formatDue(note.dueDate, note.dueTime);
  emitToTenant(note.tenantId, 'voice_note_updated', { id: note.id, status: 'converted' });

  // Templates (see env.ts). Owner: {{1}} work id, {{2}} employee, {{3}} work, {{4}} due.
  const ownerSend = await WhatsAppService.sendBodyTemplate(
    note.senderPhone,
    env.WHATSAPP_WORK_OWNER_TEMPLATE,
    env.WHATSAPP_WORK_TEMPLATE_LANG,
    [workId, fullName(member), title, due],
  );

  // Employee: {{1}} employee first name, {{2}} owner, {{3}} work id, {{4}} work, {{5}} due.
  let employeeNotified = false;
  if (member.phone) {
    const employeeSend = await WhatsAppService.sendBodyTemplate(
      member.phone,
      env.WHATSAPP_WORK_EMPLOYEE_TEMPLATE,
      env.WHATSAPP_WORK_TEMPLATE_LANG,
      [member.firstName, ownerName, workId, title, due],
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
  /** Assigns a freshly ingested note using the name Gemini extracted, or asks for one. */
  static async assignNewNote(note: VoiceNote): Promise<AssignmentOutcome> {
    return this.resolveAndAssign(note, note.assigneeName);
  }

  /**
   * The owner answered "who should do this?" (text, or a voice note that is only a name).
   * Applies to the most recent note of this workspace still waiting within the window.
   */
  static async assignPendingNote(tenantId: string, reply: string): Promise<AssignmentOutcome> {
    const since = new Date(Date.now() - env.VOICE_ASSIGNEE_WINDOW_MINUTES * 60 * 1000);
    const [note] = await db
      .select()
      .from(voiceNotes)
      .where(and(eq(voiceNotes.tenantId, tenantId), eq(voiceNotes.status, 'awaiting_assignee'), gt(voiceNotes.updatedAt, since)))
      .orderBy(desc(voiceNotes.updatedAt))
      .limit(1);
    if (!note) return { code: 'no_pending_note' };

    // "2" picks the second of the choices offered last time
    const choice = /^\s*(\d{1,2})\s*$/.exec(reply);
    if (choice && note.assigneeCandidates?.length) {
      const picked = note.assigneeCandidates[Number(choice[1]) - 1];
      const member = picked && (await loadMembers(tenantId)).find((m) => m.id === picked.id);
      if (member) return createAssignedTask(note, member);
    }
    return this.resolveAndAssign(note, reply);
  }

  private static async resolveAndAssign(note: VoiceNote, spokenName: string | null): Promise<AssignmentOutcome> {
    const heardName = (spokenName || '').trim();
    if (!heardName) {
      await markAwaitingAssignee(note, null, []);
      return { code: 'assignee_required' };
    }

    const members = await loadMembers(note.tenantId);
    const result = matchMemberName(heardName, members);
    if (result.kind === 'match') return createAssignedTask(note, result.member);

    const offered = result.kind === 'ambiguous' ? result.candidates : result.suggestions;
    await markAwaitingAssignee(note, heardName, offered);
    const choices = offered.map(fullName);
    return result.kind === 'ambiguous'
      ? { code: 'assignee_ambiguous', heardName, choices }
      : { code: 'assignee_not_found', heardName, choices };
  }
}
