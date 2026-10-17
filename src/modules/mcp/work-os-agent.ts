import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { SectionsService } from '../sections/sections.service';
import { TOOLS } from './mcp-server';
import { McpInputError, today } from './mcp-data';
import type { McpContext, McpSection } from './mcp-keys.service';

/**
 * Answers a WhatsApp question with Work OS data: Gemini with the same read-only tools as the MCP server, locked to
 * the sender's own workspace (from their registered number). Group chats are left out: they are private talk.
 */

const MAX_ROUNDS = 6;
const MAX_ANSWER = 1500;
const BOT_SECTIONS: McpSection[] = ['tasks', 'projects', 'attendance', 'leave', 'hours', 'clients', 'reminders'];
const NEEDS: Record<string, string> = { tasks: 'tasks', projects: 'projects', attendance: 'attendance', leave: 'leave', hours: 'tasks', clients: 'clients', reminders: 'reminders' };

/** Tool parameters as JSON Schema for Gemini */
function parametersFor(shape: Record<string, z.ZodTypeAny>) {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, any>;
  delete schema.$schema;
  delete schema.additionalProperties;
  return schema;
}

/** The model call; replaceable in tests */
export const agentModel = {
  async generate(body: unknown): Promise<any> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Gemini answered ${res.status}: ${data?.error?.message ?? 'no details'}`);
    return data;
  },
};

export const WorkOsAgent = {
  available: () => !!env.GEMINI_API_KEY,

  /** A short WhatsApp answer, or null when the AI could not answer (the caller falls back to the fixed replies) */
  async answer(tenantId: string, question: string, askedBy?: string | null): Promise<string | null> {
    const on = await SectionsService.forTenant(tenantId);
    const sections = new Set(BOT_SECTIONS.filter((s) => (on as Record<string, boolean>)[NEEDS[s]] !== false));
    const ctx: McpContext = { keyId: 'whatsapp-bot', tenantId, keyName: 'WhatsApp bot', sections };
    const tools = Object.entries(TOOLS).filter(([, t]) => !t.section || sections.has(t.section));
    const [ws] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);

    const system = [
      `You answer questions on WhatsApp for the "${ws?.name ?? 'Work OS'}" workspace in Work OS, using only the tools' data.`,
      `Today is ${today()} (India time).${askedBy ? ` The question is from ${askedBy}.` : ''}`,
      'Use the tools to look things up; never guess numbers, names or dates. If the data does not answer it, say so briefly.',
      'Never give a bare "no one" or "none": also say what is actually the case, so the answer cannot mislead (e.g. "No one is late — all 10 are absent; Akash checked in at 5:10 pm, after noon, so he counts as absent"). Use the counts and rules the tools return.',
      'Reply in the language of the question (Malayalam, English or a mix as they wrote). Keep it short: plain text, no markdown tables,',
      'at most about 12 lines; lists as "• " lines; work items as their W-number. Dates like "17 Oct". Hours like "2h 30m".',
    ].join(' ');
    const contents: any[] = [{ role: 'user', parts: [{ text: question }] }];
    const declarations = tools.map(([name, t]) => ({ name, description: t.description, parametersJsonSchema: parametersFor(t.input) }));

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const data = await agentModel.generate({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        generationConfig: { temperature: 0.1 },
      });
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const text = parts.map((p) => p.text ?? '').join('').trim();
        return text ? text.slice(0, MAX_ANSWER) : null;
      }
      contents.push({ role: 'model', parts });
      const responses = [];
      for (const { functionCall } of calls) {
        const def = TOOLS[functionCall.name];
        let response: unknown;
        if (!def || (def.section && !sections.has(def.section))) {
          response = { error: 'That information is not available here.' };
        } else {
          try {
            const args = z.object(def.input).parse(functionCall.args ?? {});
            response = { result: await def.run(ctx, args) };
          } catch (err) {
            response = { error: err instanceof McpInputError ? err.message : err instanceof z.ZodError ? `Bad arguments: ${err.issues[0]?.message}` : 'Could not read this right now.' };
            if (!(err instanceof McpInputError) && !(err instanceof z.ZodError)) logger.warn({ err, tool: functionCall.name }, '[WorkOsAgent] Tool failed');
          }
        }
        responses.push({ functionResponse: { name: functionCall.name, response } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    logger.warn({ tenantId }, '[WorkOsAgent] No answer after the maximum number of lookups');
    return null;
  },
};
