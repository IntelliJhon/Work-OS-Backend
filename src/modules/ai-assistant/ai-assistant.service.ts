import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { db } from '../../db';
import { aiActions, aiConversations, aiFiles, aiMessages } from '../../db/schema/ai_assistant';
import { tenants } from '../../db/schema/tenants';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { claude, claudeAvailable, claudeDefaults } from '../../lib/claude';
import { UploadService } from '../uploads/upload.service';
import { LeadError, LeadsService, type Access } from '../leads/leads.service';
import { allows, roleAccess } from '../sections/role-access';
import { SectionsService } from '../sections/sections.service';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AI_TOOLS, toolDefinitions, type AiToolName, type ToolContext } from './ai-tools';

/**
 * The in-app AI assistant: a chat with Claude per person, with tools for leads and proposals. The history is stored
 * exactly as Claude returned it (append-only), files shared in the chat go both to Work OS (so they can become
 * proposals) and to Claude (so it can read them), and a proposal is only sent to a client after the person clicks
 * Send on the card the assistant prepares.
 */

export class AiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface Asker { tenantId: string; userId: string; roleId: string }

const MAX_ROUNDS = 8;
const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// How long Claude keeps a shared file (its maximum, 90 days)
const CLAUDE_FILE_SECONDS = 90 * 86_400;
// Notes Work OS adds to the history (the user's Send / Cancel), shown in the chat as events
const EVENT = '[Work OS] ';
const FILE_MARK = '[Shared file ';
// The time each message was written; it rides in the message, not the system prompt, which must never change
// within a chat (Claude ties its earlier reasoning to the exact prompt)
const NOW_MARK = '[Now: ';

type Param = Anthropic.Beta.BetaMessageParam;

async function leadAccess(asker: Asker): Promise<Access> {
  const role = await roleAccess(asker.tenantId, asker.roleId);
  const on = await SectionsService.forTenant(asker.tenantId);
  const leadsOn = (on as Record<string, boolean>).leads !== false;
  return {
    userId: asker.userId,
    admin: role.admin,
    read: leadsOn && (allows(role, 'lead.read') || allows(role, 'lead.manage')),
    manage: leadsOn && allows(role, 'lead.manage'),
  };
}

const today = () => new Date().toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: env.WORK_TIMEZONE });

function errorText(err: unknown) {
  if (err instanceof LeadError) return err.message;
  if (err instanceof z.ZodError) return `Invalid input: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
  return 'That did not work right now.';
}

export class AiAssistantService {
  static available = claudeAvailable;

  private static async conversation(asker: Asker, id: string) {
    const [c] = await db.select().from(aiConversations)
      .where(and(eq(aiConversations.id, id), eq(aiConversations.tenantId, asker.tenantId), eq(aiConversations.userId, asker.userId))).limit(1);
    if (!c) throw new AiError(404, 'not_found', 'Chat not found');
    return c;
  }

  static async conversations(asker: Asker) {
    return db.select({ id: aiConversations.id, title: aiConversations.title, updatedAt: aiConversations.updatedAt }).from(aiConversations)
      .where(and(eq(aiConversations.tenantId, asker.tenantId), eq(aiConversations.userId, asker.userId)))
      .orderBy(desc(aiConversations.updatedAt)).limit(30);
  }

  static async remove(asker: Asker, id: string) {
    await this.conversation(asker, id);
    await db.delete(aiConversations).where(eq(aiConversations.id, id));
    return { deleted: true };
  }

  /** The chat for display: the user's words and files, the assistant's replies and what it did, and the Send cards */
  static async view(asker: Asker, id: string) {
    const c = await this.conversation(asker, id);
    const rows = await db.select().from(aiMessages).where(eq(aiMessages.conversationId, id)).orderBy(asc(aiMessages.seq));
    const items: { id: string; role: 'user' | 'assistant' | 'event'; text: string; files: string[]; steps: string[]; createdAt: Date }[] = [];
    for (const m of rows) {
      const blocks = m.content as any[];
      if (m.role === 'user') {
        const texts = blocks.filter((b) => b.type === 'text').map((b) => String(b.text));
        if (!texts.length) continue; // tool results
        if (texts.every((t) => t.startsWith(EVENT))) {
          items.push({ id: m.id, role: 'event', text: texts.map((t) => t.slice(EVENT.length)).join('\n'), files: [], steps: [], createdAt: m.createdAt });
          continue;
        }
        const files = texts.filter((t) => t.startsWith(FILE_MARK)).map((t) => t.slice(FILE_MARK.length).split('"')[1] ?? 'file');
        const said = texts.filter((t) => !t.startsWith(FILE_MARK) && !t.startsWith(NOW_MARK)).join('\n').trim();
        items.push({ id: m.id, role: 'user', text: said, files, steps: [], createdAt: m.createdAt });
      } else {
        const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n').trim();
        const steps = blocks.filter((b) => b.type === 'tool_use').map((b) => {
          const t = AI_TOOLS[b.name as AiToolName] as any;
          try { return t ? t.label(b.input ?? {}) : b.name; } catch { return b.name; }
        });
        // Steps then the answer: one item per assistant turn, merged with the previous one while it is only steps
        const last = items[items.length - 1];
        if (last?.role === 'assistant' && !last.text) {
          last.steps.push(...steps);
          last.text = text;
        } else {
          items.push({ id: m.id, role: 'assistant', text, files: [], steps, createdAt: m.createdAt });
        }
      }
    }
    const actions = await db.select().from(aiActions).where(eq(aiActions.conversationId, id)).orderBy(asc(aiActions.createdAt));
    return {
      id: c.id,
      title: c.title,
      items,
      actions: actions.map((a) => ({ id: a.id, kind: a.kind, payload: a.payload, status: a.status, result: a.result, createdAt: a.createdAt })),
    };
  }

  /** Adds the user's message (and files) and lets Claude answer, using tools as needed */
  static async send(asker: Asker, input: { conversationId?: string; text: string; files: Express.Multer.File[] }) {
    if (!claudeAvailable()) throw new AiError(503, 'ai_not_configured', 'The AI assistant is not set up yet (ANTHROPIC_API_KEY is missing on the server)');
    const text = input.text.trim();
    if (!text && !input.files.length) throw new AiError(400, 'empty', 'Type a message or share a file');
    const bad = input.files.find((f) => !FILE_TYPES.includes(f.mimetype));
    if (bad) throw new AiError(400, 'file_type', `"${bad.originalname}" can't be shared here. Use PDF or image files.`);

    const conv = input.conversationId
      ? await this.conversation(asker, input.conversationId)
      : (await db.insert(aiConversations).values({
        tenantId: asker.tenantId, userId: asker.userId, title: (text || input.files[0]?.originalname || 'New chat').replace(/\s+/g, ' ').slice(0, 80),
      }).returning())[0];

    // Files: a Work OS copy (can become a proposal) and a Claude copy (to read)
    const content: any[] = [{ type: 'text', text: `${NOW_MARK}${today()} India time]` }];
    for (const file of input.files) {
      const up = await UploadService.processUpload({ tenantId: asker.tenantId, uploaderId: asker.userId, entityType: 'AI_CHAT', entityId: conv.id, file });
      const cf = await claude().files.upload({ file: await toFile(file.buffer, file.originalname, { type: file.mimetype }), expires_in_seconds: CLAUDE_FILE_SECONDS });
      const [f] = await db.insert(aiFiles).values({
        tenantId: asker.tenantId, conversationId: conv.id, uploadId: up.id, claudeFileId: cf.id, name: file.originalname, mimeType: file.mimetype, size: file.size,
      }).returning();
      content.push({ type: 'text', text: `${FILE_MARK}"${file.originalname}" — chat file id ${f.id}]` });
      content.push(file.mimetype === 'application/pdf'
        ? { type: 'document', source: { type: 'file', file_id: cf.id }, title: file.originalname }
        : { type: 'image', source: { type: 'file', file_id: cf.id } });
    }
    if (text) content.push({ type: 'text', text });
    await db.insert(aiMessages).values({ tenantId: asker.tenantId, conversationId: conv.id, role: 'user', content });

    await this.run(asker, conv.id);
    await db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conv.id));
    return this.view(asker, conv.id);
  }

  /** Claude's turn: answer, or call tools and continue, until it has a reply for the user */
  private static async run(asker: Asker, conversationId: string) {
    const access = await leadAccess(asker);
    const ctx: ToolContext = { tenantId: asker.tenantId, conversationId, access };
    const [ws] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, asker.tenantId)).limit(1);
    const [me] = await withTenant<{ firstName: string; lastName: string }[]>(asker.tenantId, (tx) =>
      tx.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, asker.userId)).limit(1));
    const system = [
      `You are the AI assistant inside Work OS for the "${ws?.name ?? 'Work OS'}" workspace, talking with ${me ? `${me.firstName} ${me.lastName}`.trim() : 'a team member'}.`,
      'You help with leads and proposals: find and add leads, update them, move them through the stages (Lead created, Contacted, Requirement collected, Proposal sent, Follow up, Accepted, Rejected), add notes, attach a proposal file the user shares, and prepare it to be sent to the client on WhatsApp.',
      'Use the tools for every fact and change; never guess names, numbers, ids or dates. Find a lead before acting on it; if several match or the request is unclear, ask.',
      'When the user shares a proposal PDF, read it: use it to find or fill in the lead (client name, company, service, amount) and attach it with attach_proposal.',
      'Sending to a client only shows the user a Send / Cancel card. Never say anything was sent unless a "[Work OS]" note in the chat says the user clicked Send and it went out. You cannot send email.',
      'If a tool says the user\'s role cannot do something, explain that plainly.',
      'Each user message starts with "[Now: …]", the date and time it was written (India time); use it for "today", "tomorrow" and follow-up times.',
      'Reply briefly in the user\'s language, as plain chat text (short lines or "• " lists, no tables).',
    ].join('\n');
    const tools = toolDefinitions();

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rows = await db.select({ role: aiMessages.role, content: aiMessages.content }).from(aiMessages)
        .where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.seq));
      const messages = rows.map((r) => ({ role: r.role, content: r.content })) as Param[];
      let reply: Anthropic.Beta.BetaMessage;
      try {
        reply = await claude().beta.messages.create({
          ...claudeDefaults(),
          // Chats written before the prompt was made fixed carry reasoning tied to the old prompt: drop it, don't fail
          betas: [...claudeDefaults().betas, 'thinking-binding-controls-2026-08-01'],
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
          max_tokens: 16000,
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          system,
          tools,
          messages,
        }, { timeout: 120_000 });
      } catch (err) {
        logger.warn({ err, conversationId }, '[AiAssistant] Claude request failed');
        throw new AiError(502, 'ai_failed', 'The AI could not answer right now. Please try again.');
      }
      if (reply.stop_reason === 'refusal') {
        await db.insert(aiMessages).values({ tenantId: asker.tenantId, conversationId, role: 'assistant', content: [{ type: 'text', text: 'Sorry, I can\'t help with that.' }] });
        return;
      }
      await db.insert(aiMessages).values({ tenantId: asker.tenantId, conversationId, role: 'assistant', content: reply.content as unknown[] });
      const uses = reply.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (reply.stop_reason !== 'tool_use' || !uses.length) return;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const t = AI_TOOLS[use.name as AiToolName] as any;
        try {
          if (!t) throw new LeadError(400, 'tool', `Unknown tool ${use.name}`);
          const args = z.object(t.input).parse(use.input ?? {});
          const out = await t.run(ctx, args);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out ?? null) });
        } catch (err) {
          if (!(err instanceof LeadError) && !(err instanceof z.ZodError)) logger.warn({ err, tool: use.name }, '[AiAssistant] Tool failed');
          const extra = err instanceof LeadError && err.data ? ` ${JSON.stringify(err.data)}` : '';
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: errorText(err) + extra });
        }
      }
      await db.insert(aiMessages).values({ tenantId: asker.tenantId, conversationId, role: 'user', content: results as unknown[] });
    }
    await db.insert(aiMessages).values({ tenantId: asker.tenantId, conversationId, role: 'assistant', content: [{ type: 'text', text: 'That took too many steps. Could you break it into smaller requests?' }] });
  }

  // ─── Send / Cancel cards ─────────────────────────────────────────────────────

  private static async action(asker: Asker, id: string) {
    const [a] = await db.select().from(aiActions)
      .where(and(eq(aiActions.id, id), eq(aiActions.tenantId, asker.tenantId), eq(aiActions.userId, asker.userId))).limit(1);
    if (!a) throw new AiError(404, 'not_found', 'Not found');
    if (a.status !== 'pending') throw new AiError(409, 'decided', 'This was already handled');
    return a;
  }

  private static async note(asker: Asker, conversationId: string, text: string) {
    await db.insert(aiMessages).values({ tenantId: asker.tenantId, conversationId, role: 'user', content: [{ type: 'text', text: EVENT + text }] });
    await db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
  }

  /** The user clicked Send: the proposal goes to the client (moving the lead to Proposal sent if it was earlier) */
  static async confirm(asker: Asker, id: string) {
    const a = await this.action(asker, id);
    // Claim it first, so a double click sends once
    const [claimed] = await db.update(aiActions).set({ status: 'done', decidedAt: new Date() })
      .where(and(eq(aiActions.id, a.id), eq(aiActions.status, 'pending'))).returning();
    if (!claimed) throw new AiError(409, 'decided', 'This was already handled');
    // Email cards from when company email was on can no longer be sent
    if (a.kind === 'send_email') throw new AiError(410, 'email_off', 'Sending email from Work OS is turned off');
    const p = a.payload as { leadId: string; leadName: string; proposalId: string; version: number; fileName: string };
    let result: string;
    let ok = false;
    try {
      const access = await leadAccess(asker);
      const lead = await LeadsService.get(asker.tenantId, access, p.leadId);
      if (['new', 'contacted', 'requirement'].includes(lead.stage)) {
        await LeadsService.moveStage(asker.tenantId, access, p.leadId, { stage: 'proposal' });
      }
      const sent = await LeadsService.sendProposal(asker.tenantId, access, p.leadId, p.proposalId);
      ok = sent.sent;
      result = sent.sent
        ? `Proposal v${p.version} (${p.fileName}) was sent to ${p.leadName} on WhatsApp.`
        : `Proposal v${p.version} could not be sent on WhatsApp: ${sent.error}`;
    } catch (err) {
      result = `Proposal v${p.version} was not sent: ${errorText(err)}`;
    }
    await db.update(aiActions).set({ status: ok ? 'done' : 'failed', result }).where(eq(aiActions.id, a.id));
    await this.note(asker, a.conversationId, `The user clicked Send. ${result}`);
    return this.view(asker, a.conversationId);
  }

  static async cancel(asker: Asker, id: string) {
    const a = await this.action(asker, id);
    const p = a.payload as { leadName?: string; version?: number; subject?: string };
    await db.update(aiActions).set({ status: 'cancelled', result: 'Cancelled', decidedAt: new Date() }).where(and(eq(aiActions.id, a.id), eq(aiActions.status, 'pending')));
    await this.note(asker, a.conversationId, a.kind === 'send_email'
      ? `The user cancelled the email "${p.subject}". Nothing was sent.`
      : `The user cancelled sending proposal v${p.version} to ${p.leadName}. Nothing was sent.`);
    return this.view(asker, a.conversationId);
  }
}
