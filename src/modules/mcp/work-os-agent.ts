import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { claude, claudeAvailable, claudeDefaults, replyText } from '../../lib/claude';
import { logger } from '../../config/logger';
import { SectionsService } from '../sections/sections.service';
import { TOOLS } from './mcp-server';
import { McpInputError, today } from './mcp-data';
import type { McpContext, McpSection } from './mcp-keys.service';

/**
 * Answers a WhatsApp question with Work OS data: Claude with the same read-only tools as the MCP server, locked to
 * the sender's own workspace (from their registered number). Group chats are left out: they are private talk.
 */

const MAX_ROUNDS = 6;
const MAX_ANSWER = 1500;
const BOT_SECTIONS: McpSection[] = ['tasks', 'projects', 'attendance', 'leave', 'hours', 'clients', 'reminders'];
const NEEDS: Record<string, string> = { tasks: 'tasks', projects: 'projects', attendance: 'attendance', leave: 'leave', hours: 'tasks', clients: 'clients', reminders: 'reminders' };

/** Tool parameters as JSON Schema for Claude */
function parametersFor(shape: Record<string, z.ZodTypeAny>): Anthropic.Beta.BetaTool.InputSchema {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, any>;
  delete schema.$schema;
  return schema as Anthropic.Beta.BetaTool.InputSchema;
}

/** The model call; replaceable in tests */
export const agentModel = {
  async create(params: { system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools: Anthropic.Beta.BetaTool[] }) {
    // A WhatsApp chat answer: low effort keeps it quick
    return claude().beta.messages.create({
      ...claudeDefaults(),
      max_tokens: 8000,
      output_config: { effort: 'low' },
      ...params,
    }, { timeout: 40_000 });
  },
};

export const WorkOsAgent = {
  available: claudeAvailable,

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
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: question }];
    const toolDefs: Anthropic.Beta.BetaTool[] = tools.map(([name, t]) => ({ name, description: t.description, input_schema: parametersFor(t.input) }));

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await agentModel.create({ system, messages, tools: toolDefs });
      // Declined even after the fallback: the caller sends the fixed replies
      if (reply.stop_reason === 'refusal') return null;
      const uses = reply.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (!uses.length || reply.stop_reason !== 'tool_use') {
        const text = replyText(reply);
        return text ? text.slice(0, MAX_ANSWER) : null;
      }
      messages.push({ role: 'assistant', content: reply.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const def = TOOLS[use.name];
        let result: unknown;
        let failed = false;
        if (!def || (def.section && !sections.has(def.section))) {
          result = 'That information is not available here.';
          failed = true;
        } else {
          try {
            result = await def.run(ctx, z.object(def.input).parse(use.input ?? {}));
          } catch (err) {
            failed = true;
            result = err instanceof McpInputError ? err.message : err instanceof z.ZodError ? `Bad arguments: ${err.issues[0]?.message}` : 'Could not read this right now.';
            if (!(err instanceof McpInputError) && !(err instanceof z.ZodError)) logger.warn({ err, tool: use.name }, '[WorkOsAgent] Tool failed');
          }
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: typeof result === 'string' ? result : JSON.stringify(result), ...(failed ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    logger.warn({ tenantId }, '[WorkOsAgent] No answer after the maximum number of lookups');
    return null;
  },
};
