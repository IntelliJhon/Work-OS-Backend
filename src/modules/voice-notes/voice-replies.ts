import { WhatsAppService } from '../../services/whatsapp.service';
import { maskPhone } from '../../lib/phone';
import { logger } from '../../config/logger';

/**
 * WhatsApp replies to the person who messaged the bot. They are sent by Work OS (not returned in the
 * webhook response) because transcription takes longer than WAAU waits for a webhook reply.
 * Free-form messages are only delivered inside Meta's 24-hour window, i.e. to someone who just
 * messaged the bot, so they cannot be used to message arbitrary numbers.
 */

export type ReplyContext =
  | { code: 'task_created'; workId: string | null; assigneeName: string; ownerNotified: boolean; employeeNotified: boolean; employeeHasPhone: boolean }
  | { code: 'assignee_required' }
  | { code: 'assignee_ambiguous' | 'assignee_not_found'; heardName: string; choices: string[] }
  | { code: 'no_pending_note' }
  | { code: 'created'; status: string }
  | { code: 'number_not_registered' }
  | { code: 'duplicate' | 'already_assigned' }
  | { code: 'error' };

const numbered = (choices: string[]) => choices.map((c, i) => `${i + 1}. ${c}`).join('\n');

export function buildReply(ctx: ReplyContext, workspace?: string): string | null {
  switch (ctx.code) {
    case 'task_created': {
      // The owner template already confirms the work; only add what it can't say
      const lines: string[] = [];
      if (!ctx.ownerNotified) lines.push(`✅ Work ${ctx.workId} has been assigned to ${ctx.assigneeName}.`);
      if (!ctx.employeeHasPhone) {
        lines.push(`ℹ️ ${ctx.assigneeName} has no WhatsApp number in Work OS, so they were not notified. Add it under Settings → Members.`);
      } else if (!ctx.employeeNotified) {
        lines.push(`ℹ️ The WhatsApp message to ${ctx.assigneeName} could not be sent. The work is in Work OS.`);
      }
      return lines.length ? lines.join('\n\n') : null;
    }
    case 'assignee_required':
      return "🎙️ Got it. Who should do this work? Reply with the employee's name.";
    case 'assignee_ambiguous':
      return `Which ${ctx.heardName}?\n${numbered(ctx.choices)}\n\nReply with the number or the full name.`;
    case 'assignee_not_found': {
      const where = workspace ? ` in ${workspace}` : '';
      return ctx.choices.length
        ? `I couldn't find "${ctx.heardName}"${where}. Did you mean:\n${numbered(ctx.choices)}\n\nReply with the number or the correct name.`
        : `I couldn't find "${ctx.heardName}"${where}. Reply with the employee's name as it appears in Work OS.`;
    }
    case 'no_pending_note':
      return 'Please send the work as a voice note or a message, and say who should do it.';
    case 'created':
      return ctx.status === 'unclear'
        ? "🎙️ Voice note received. It wasn't fully clear, so your team will listen to the recording."
        : '✅ Received. Your team can see it in the Work OS Voice Notes inbox.';
    case 'number_not_registered':
      return "This WhatsApp number isn't registered with Work OS. Ask your workspace admin to add it under Settings → Voice Notes.";
    case 'error':
      return 'Sorry, we could not process your message right now. Please try again in a few minutes.';
    default:
      return null; // duplicate / already handled: never reply twice
  }
}

// At most one "not registered" reply per number per 10 minutes
const notRegisteredSentAt = new Map<string, number>();
const NOT_REGISTERED_COOLDOWN_MS = 10 * 60 * 1000;

/** Sends the reply for this outcome, if any. Never throws; returns whether a message was sent. */
export async function sendReply(phone: string, ctx: ReplyContext, workspace?: string): Promise<boolean> {
  if (ctx.code === 'number_not_registered') {
    const last = notRegisteredSentAt.get(phone) ?? 0;
    if (Date.now() - last < NOT_REGISTERED_COOLDOWN_MS) return false;
    notRegisteredSentAt.set(phone, Date.now());
    if (notRegisteredSentAt.size > 5000) notRegisteredSentAt.clear();
  }

  const text = buildReply(ctx, workspace);
  if (!text) return false;
  try {
    const result = await WhatsAppService.sendText(phone, text);
    if (!result.success) {
      logger.warn({ to: maskPhone(phone), code: ctx.code, error: result.error }, '[VoiceReplies] Reply not sent');
    }
    return result.success;
  } catch (err: any) {
    logger.warn({ to: maskPhone(phone), code: ctx.code, error: err?.message }, '[VoiceReplies] Reply failed');
    return false;
  }
}
