import { Response, NextFunction } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AuthRequest } from '../../middleware/auth.middleware';
import { db } from '../../db';
import { alias } from 'drizzle-orm/pg-core';
import { voiceNotes, VoiceNoteStatus, VOICE_NOTE_STATUSES } from '../../db/schema/voice_notes';
import { users } from '../../db/schema/users';
import { tasks } from '../../db/schema/tasks';
import { withTenant } from '../../middleware/tenant.middleware';
import { formatWorkId } from '../tasks/tasks.service';
import { VoiceSettingsService, VoiceSettingsError } from './voice-settings.service';
import { getIoInstance } from '../../socket/socketServer';
import { getTenantRoom } from '../../socket/tenantRooms';
import { logger } from '../../config/logger';

const assignee = alias(users, 'assignee');

const handleError = (err: any, res: Response, next: NextFunction) => {
  if (err instanceof VoiceSettingsError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  return next(err);
};

/**
 * Every tenant member receives this event regardless of permissions, so payloads must stay minimal
 * (ids/status only) and never include phone numbers, transcripts or audio URLs.
 */
export const emitToTenant = (tenantId: string, event: string, payload: { id: string; status: string }) => {
  try {
    getIoInstance().to(getTenantRoom(tenantId)).emit(event, payload);
  } catch (err: any) {
    logger.warn({ event, tenantId, error: err?.message }, '[VoiceNotes] Socket emit skipped');
  }
};

export class VoiceNotesController {
  // ---------- Settings (Admin) ----------

  static async getSettings(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const data = await VoiceSettingsService.getSettings(req.user!.tenantId);
      return res.json({ success: true, data });
    } catch (err) {
      return handleError(err, res, next);
    }
  }

  static async sendCode(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const data = await VoiceSettingsService.sendCode(req.user!.tenantId, req.body.phone);
      return res.json({ success: true, data });
    } catch (err) {
      return handleError(err, res, next);
    }
  }

  static async verifyCode(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const data = await VoiceSettingsService.verifyCode(req.user!.tenantId, req.user!.id, req.body.code);
      return res.json({ success: true, data });
    } catch (err) {
      return handleError(err, res, next);
    }
  }

  static async removeNumber(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const data = await VoiceSettingsService.removeNumber(req.user!.tenantId);
      return res.json({ success: true, data });
    } catch (err) {
      return handleError(err, res, next);
    }
  }

  // ---------- Inbox ----------

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const status = req.query.status as VoiceNoteStatus | undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Number(req.query.offset) || 0;

      const where = status
        ? and(eq(voiceNotes.tenantId, tenantId), eq(voiceNotes.status, status))
        : eq(voiceNotes.tenantId, tenantId);

      // users and tasks have row-level security, so joins must run with the tenant context set
      const { rows, countRows } = await withTenant(tenantId, async (tx) => {
        const rows = await tx
          .select({
            note: voiceNotes,
            senderFirstName: users.firstName,
            senderLastName: users.lastName,
            taskNumber: tasks.taskNumber,
            assigneeFirstName: assignee.firstName,
            assigneeLastName: assignee.lastName,
          })
          .from(voiceNotes)
          .leftJoin(users, eq(users.id, voiceNotes.senderUserId))
          .leftJoin(tasks, eq(tasks.id, voiceNotes.taskId))
          .leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
          .where(where)
          .orderBy(desc(voiceNotes.createdAt))
          .limit(limit)
          .offset(offset);

        const countRows = await tx
          .select({ status: voiceNotes.status, count: sql<number>`count(*)::int` })
          .from(voiceNotes)
          .where(eq(voiceNotes.tenantId, tenantId))
          .groupBy(voiceNotes.status);
        return { rows, countRows };
      });

      const counts = Object.fromEntries(VOICE_NOTE_STATUSES.map((s) => [s, 0])) as Record<VoiceNoteStatus, number>;
      for (const r of countRows as { status: VoiceNoteStatus; count: number }[]) counts[r.status] = r.count;

      const joinName = (first: string | null, last: string | null) => [first, last].filter(Boolean).join(' ') || null;
      return res.json({
        success: true,
        data: (rows as any[]).map((r) => ({
          ...r.note,
          senderName: joinName(r.senderFirstName, r.senderLastName),
          workId: formatWorkId(r.taskNumber),
          taskAssigneeName: joinName(r.assigneeFirstName, r.assigneeLastName),
        })),
        counts,
        pagination: { limit, offset },
      });
    } catch (err) {
      return next(err);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const id = req.params.id as string;
      const { status, taskId } = req.body as { status?: VoiceNoteStatus; taskId?: string | null };

      const [existing] = await db
        .select({ id: voiceNotes.id })
        .from(voiceNotes)
        .where(and(eq(voiceNotes.id, id), eq(voiceNotes.tenantId, tenantId)))
        .limit(1);
      if (!existing) return res.status(404).json({ error: 'Voice note not found' });

      const patch: Partial<typeof voiceNotes.$inferInsert> = {
        reviewedBy: req.user!.id,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      };

      if (taskId !== undefined) {
        if (taskId !== null) {
          // The task must belong to the same workspace (tasks has row-level security: needs the tenant context)
          const [task] = await withTenant<{ id: string }[]>(tenantId, (tx) =>
            tx
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
              .limit(1),
          );
          if (!task) return res.status(400).json({ error: 'Task not found in this workspace' });
        }
        patch.taskId = taskId;
        patch.status = taskId ? 'converted' : status ?? 'new';
      }
      if (status !== undefined && taskId === undefined) {
        patch.status = status;
        if (status !== 'converted') patch.taskId = null;
      }

      const [updated] = await db
        .update(voiceNotes)
        .set(patch)
        .where(and(eq(voiceNotes.id, id), eq(voiceNotes.tenantId, tenantId)))
        .returning();

      emitToTenant(tenantId, 'voice_note_updated', { id: updated.id, status: updated.status });
      return res.json({ success: true, data: updated });
    } catch (err) {
      return next(err);
    }
  }

  /** Permanently deletes a voice note. Only dismissed notes can be deleted (dismiss first). */
  static async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const id = req.params.id as string;

      const [deleted] = await db
        .delete(voiceNotes)
        .where(and(eq(voiceNotes.id, id), eq(voiceNotes.tenantId, tenantId), eq(voiceNotes.status, 'dismissed')))
        .returning({ id: voiceNotes.id });

      if (!deleted) {
        const [existing] = await db
          .select({ id: voiceNotes.id })
          .from(voiceNotes)
          .where(and(eq(voiceNotes.id, id), eq(voiceNotes.tenantId, tenantId)))
          .limit(1);
        return existing
          ? res.status(409).json({ error: 'Only dismissed voice notes can be deleted', code: 'not_dismissed' })
          : res.status(404).json({ error: 'Voice note not found' });
      }

      logger.info({ tenantId, voiceNoteId: id, userId: req.user!.id }, '[VoiceNotes] Voice note deleted');
      emitToTenant(tenantId, 'voice_note_updated', { id, status: 'deleted' });
      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  }
}
