import { Response, NextFunction } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AuthRequest } from '../../middleware/auth.middleware';
import { db } from '../../db';
import { voiceNotes, VoiceNoteStatus } from '../../db/schema/voice_notes';
import { users } from '../../db/schema/users';
import { tasks } from '../../db/schema/tasks';
import { VoiceSettingsService, VoiceSettingsError } from './voice-settings.service';
import { getIoInstance } from '../../socket/socketServer';
import { getTenantRoom } from '../../socket/tenantRooms';
import { logger } from '../../config/logger';

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

      const rows = await db
        .select({
          note: voiceNotes,
          senderFirstName: users.firstName,
          senderLastName: users.lastName,
        })
        .from(voiceNotes)
        .leftJoin(users, eq(users.id, voiceNotes.senderUserId))
        .where(where)
        .orderBy(desc(voiceNotes.createdAt))
        .limit(limit)
        .offset(offset);

      const countRows = await db
        .select({ status: voiceNotes.status, count: sql<number>`count(*)::int` })
        .from(voiceNotes)
        .where(eq(voiceNotes.tenantId, tenantId))
        .groupBy(voiceNotes.status);

      const counts = { new: 0, converted: 0, dismissed: 0, unclear: 0 } as Record<VoiceNoteStatus, number>;
      for (const r of countRows) counts[r.status as VoiceNoteStatus] = r.count;

      return res.json({
        success: true,
        data: rows.map((r) => ({
          ...r.note,
          senderName: [r.senderFirstName, r.senderLastName].filter(Boolean).join(' ') || null,
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
          // The task must belong to the same workspace
          const [task] = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
            .limit(1);
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
}
