import { and, asc, eq, gte, isNull, lt } from 'drizzle-orm';
import { db } from '../../db';
import { chatMessages, chatSummaries, type SummaryContent } from '../../db/schema/chat_groups';
import { isRealDay, localParts } from '../attendance/attendance.service';
import { atLocal } from '../due-reminders/due-reminders.service';
import { GroupError, GroupsService } from './groups.service';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * One-click AI summary of a group's messages for a range of local days (Gemini). Members only. A summary is
 * saved per group and range; it is reused until a newer message arrives in that range (or someone asks again).
 * Action items are linked to group members by name so the app can turn them into tasks.
 */

const MAX_DAYS = 31;
const MAX_MESSAGES = 1500;
const MAX_CHARS = 120_000;

const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const clock = (at: Date) => localParts(at).hhmm;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    keyPoints: { type: 'ARRAY', items: { type: 'STRING' } },
    decisions: { type: 'ARRAY', items: { type: 'STRING' } },
    actionItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { text: { type: 'STRING' }, person: { type: 'STRING', nullable: true }, due: { type: 'STRING', nullable: true } },
        required: ['text'],
      },
    },
    openQuestions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['keyPoints', 'decisions', 'actionItems', 'openQuestions'],
};

/** The model call; replaceable in tests */
export const summaryModel = {
  async generate(prompt: string): Promise<unknown> {
    if (!env.GEMINI_API_KEY) throw new GroupError(503, 'ai_not_configured', 'AI summaries are not set up yet (GEMINI_API_KEY is missing on the server)');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      logger.warn({ status: res.status, error: data?.error?.message }, '[GroupSummary] Gemini refused the request');
      throw new GroupError(502, 'ai_failed', 'The AI could not write the summary right now. Please try again.');
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    try {
      return JSON.parse(text);
    } catch {
      throw new GroupError(502, 'ai_failed', 'The AI could not write the summary right now. Please try again.');
    }
  },
};

const strings = (v: unknown, max = 12) =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim().slice(0, 400)).slice(0, max) : [];

export class GroupSummaryService {
  private static range(from: string, to: string) {
    if (!isRealDay(from) || !isRealDay(to)) throw new GroupError(400, 'dates', 'Choose valid dates');
    if (to < from) throw new GroupError(400, 'dates', 'The end date is before the start date');
    if (to > addDays(from, MAX_DAYS - 1)) throw new GroupError(400, 'dates', `Summaries cover at most ${MAX_DAYS} days`);
    return { start: atLocal(from, '00:00'), end: atLocal(addDays(to, 1), '00:00') };
  }

  static async summarize(tenantId: string, actorId: string, groupId: string, from: string, to: string, refresh = false) {
    const { g, list, everyone } = await GroupsService.memberContext(tenantId, actorId, groupId);
    const { start, end } = this.range(from, to);
    const rows = await db.select().from(chatMessages)
      .where(and(eq(chatMessages.groupId, groupId), isNull(chatMessages.deletedAt), gte(chatMessages.createdAt, start), lt(chatMessages.createdAt, end)))
      .orderBy(asc(chatMessages.createdAt))
      .limit(MAX_MESSAGES + 1);
    const truncated = rows.length > MAX_MESSAGES;
    const messages = rows.slice(0, MAX_MESSAGES);
    if (!messages.length) return { groupId, fromDay: from, toDay: to, empty: true as const, messageCount: 0, content: null, createdAt: null, cached: false };
    const lastAt = messages[messages.length - 1].createdAt;

    const [saved] = await db.select().from(chatSummaries)
      .where(and(eq(chatSummaries.groupId, groupId), eq(chatSummaries.fromDay, from), eq(chatSummaries.toDay, to))).limit(1);
    if (saved && !refresh && saved.messageCount === messages.length && saved.lastMessageAt?.getTime() === lastAt.getTime()) {
      return { groupId, fromDay: from, toDay: to, empty: false as const, messageCount: saved.messageCount, content: saved.content, createdAt: saved.createdAt, cached: true, truncated };
    }

    const nameOf = (id: string | null) => {
      const p = everyone.find((x) => x.id === id);
      return p ? `${p.firstName} ${p.lastName}`.trim() : 'Former member';
    };
    const memberNames = list.map((m) => nameOf(m.userId)).filter((n) => n !== 'Former member');
    let transcript = '';
    for (const m of messages) {
      const multiDay = from !== to ? `${localParts(m.createdAt).day} ` : '';
      const files = m.attachments.length ? ` [shared: ${m.attachments.map((a) => a.name).join(', ')}]` : '';
      const line = `[${multiDay}${clock(m.createdAt)}] ${nameOf(m.senderId)}: ${(m.body ?? '').slice(0, 1000)}${files}\n`;
      if (transcript.length + line.length > MAX_CHARS) break;
      transcript += line;
    }
    const prompt = [
      'You summarise a company work group chat for a busy manager.',
      'The messages may be in English, Malayalam, Manglish or Hindi. Write the summary in short, simple English.',
      'Use only what is in the messages; do not invent anything.',
      '- keyPoints: 3 to 6 short points about what was discussed (fewer if there was little).',
      '- decisions: things that were agreed or approved.',
      '- actionItems: concrete things someone has to do. "person" = who must do it, written exactly as one of the members below, or null if unclear. "due" = a deadline mentioned in the chat, or null.',
      '- openQuestions: questions or problems nobody answered or solved.',
      'Use empty lists when there is nothing for a section.',
      `Group: ${g.name}`,
      `Members: ${memberNames.join(', ')}`,
      `Messages (${from === to ? from : `${from} to ${to}`}, times are local):`,
      transcript,
    ].join('\n');

    const raw = await summaryModel.generate(prompt) as any;
    const match = (person: unknown): string | null => {
      if (typeof person !== 'string' || !person.trim()) return null;
      const p = person.trim().toLowerCase();
      const exact = list.find((m) => nameOf(m.userId).toLowerCase() === p);
      if (exact) return exact.userId;
      const partial = list.filter((m) => nameOf(m.userId).toLowerCase().split(' ')[0] === p.split(' ')[0]);
      return partial.length === 1 ? partial[0].userId : null;
    };
    const content: SummaryContent = {
      keyPoints: strings(raw?.keyPoints, 8),
      decisions: strings(raw?.decisions),
      actionItems: (Array.isArray(raw?.actionItems) ? raw.actionItems : []).slice(0, 15)
        .filter((a: any) => typeof a?.text === 'string' && a.text.trim())
        .map((a: any) => {
          const personId = match(a.person);
          return {
            text: a.text.trim().slice(0, 300),
            person: personId ? nameOf(personId) : typeof a.person === 'string' && a.person.trim() ? a.person.trim().slice(0, 80) : null,
            personId,
            due: typeof a.due === 'string' && a.due.trim() ? a.due.trim().slice(0, 80) : null,
          };
        }),
      openQuestions: strings(raw?.openQuestions),
    };
    const now = new Date();
    await db.insert(chatSummaries)
      .values({ tenantId, groupId, fromDay: from, toDay: to, content, messageCount: messages.length, lastMessageAt: lastAt, createdBy: actorId, createdAt: now })
      .onConflictDoUpdate({
        target: [chatSummaries.groupId, chatSummaries.fromDay, chatSummaries.toDay],
        set: { content, messageCount: messages.length, lastMessageAt: lastAt, createdBy: actorId, createdAt: now },
      });
    logger.info({ tenantId, groupId, from, to, messages: messages.length }, '[GroupSummary] Summary written');
    return { groupId, fromDay: from, toDay: to, empty: false as const, messageCount: messages.length, content, createdAt: now, cached: false, truncated };
  }
}
