import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../../db';
import { aiActions, aiFiles } from '../../db/schema/ai_assistant';
import { LEAD_SOURCES, LEAD_STAGES, REJECT_REASONS } from '../../db/schema/leads';
import { LeadError, LeadsService, STAGE_LABELS, type Access } from '../leads/leads.service';
import { formatLeadPhone } from './ai-format';
import { WALLET_TOOLS } from './ai-wallet-tools';

/**
 * What the assistant can do, as Claude tools. Each runs with the asking person's own lead permissions (lead.read /
 * lead.manage, Admins always), so the AI can never do more than they could in the app. Changes inside Work OS happen
 * directly and show in the lead's history; anything that reaches a client (WhatsApp) only becomes a pending action
 * that the person confirms with a click.
 */

export interface ToolContext { tenantId: string; conversationId: string; access: Access }

interface Tool<S extends z.ZodRawShape> {
  description: string;
  input: S;
  // Shown in the chat while the assistant works ("Looked up leads")
  label: (args: z.infer<z.ZodObject<S>>) => string;
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}
const tool = <S extends z.ZodRawShape>(t: Tool<S>) => t;

const leadId = z.string().uuid().describe('The lead id from find_leads or create_lead');
const when = z.string().datetime({ offset: true }).describe('ISO date-time with offset, India time is +05:30, e.g. 2026-11-04T11:00:00+05:30');

async function chatFile(ctx: ToolContext, fileId: string) {
  const [f] = await db.select().from(aiFiles)
    .where(and(eq(aiFiles.id, fileId), eq(aiFiles.conversationId, ctx.conversationId), eq(aiFiles.tenantId, ctx.tenantId))).limit(1);
  if (!f?.uploadId) throw new LeadError(404, 'file', 'That file is not in this chat');
  return f;
}

async function leadSummary(ctx: ToolContext, id: string) {
  const l = await LeadsService.get(ctx.tenantId, ctx.access, id);
  const proposals = await LeadsService.proposals(ctx.tenantId, ctx.access, id);
  const history = await LeadsService.activity(ctx.tenantId, ctx.access, id);
  return {
    id: l.id, name: l.name, company: l.company, phone: formatLeadPhone(l.phone), email: l.email, city: l.city,
    interestedIn: l.service, source: l.source, stage: STAGE_LABELS[l.stage], owner: l.ownerName,
    expectedValue: l.expectedValue, nextFollowUpAt: l.nextFollowUpAt, autoFollowUp: l.autoFollowUp,
    requirement: l.requirement, budget: l.budget, timeline: l.timeline, rejectReason: l.rejectReason, archived: !!l.archivedAt,
    proposals: proposals.map((p) => ({ id: p.id, version: p.version, amount: p.amount, file: p.file?.name ?? null, sentOnWhatsApp: p.whatsappSentAt, whatsappError: p.whatsappError })),
    recentHistory: history.items.slice(0, 8).map((a) => `${a.createdAt.toISOString().slice(0, 16)} ${a.actorName ?? 'Work OS'}: ${a.body}`),
  };
}

export const AI_TOOLS = {
  find_leads: tool({
    description: 'Search the leads by name, company, phone, city or interest. Without a query, lists the latest leads. Use before acting on a lead the user names.',
    input: { query: z.string().max(100).optional() },
    label: ({ query }) => (query ? `Searched leads for "${query}"` : 'Looked up leads'),
    run: async (ctx, { query }) => {
      const rows = await LeadsService.list(ctx.tenantId, ctx.access, { q: query });
      return rows.slice(0, 20).map((l) => ({
        id: l.id, name: l.name, company: l.company, phone: formatLeadPhone(l.phone), interestedIn: l.service,
        stage: STAGE_LABELS[l.stage], owner: l.ownerName, proposalVersion: l.proposalVersion, nextFollowUpAt: l.nextFollowUpAt,
      }));
    },
  }),

  get_lead: tool({
    description: 'Full details of one lead: contact, stage, requirement, proposals (with WhatsApp status) and recent history.',
    input: { lead_id: leadId },
    label: () => 'Opened a lead',
    run: (ctx, { lead_id }) => leadSummary(ctx, lead_id),
  }),

  list_team: tool({
    description: 'The workspace members, to choose a lead owner.',
    input: {},
    label: () => 'Looked up the team',
    run: (ctx) => LeadsService.people(ctx.tenantId, ctx.access),
  }),

  create_lead: tool({
    description: 'Add a new lead. Name and WhatsApp number are required. If the number is already on a lead, this fails and returns that lead: ask the user before retrying with allow_duplicate.',
    input: {
      name: z.string().min(2).max(120),
      phone: z.string().min(6).max(25).describe('WhatsApp number; 10 digits are taken as Indian (+91)'),
      company: z.string().max(160).optional(),
      email: z.string().email().max(255).optional(),
      city: z.string().max(80).optional(),
      interested_in: z.string().max(120).optional().describe('The service they want, as the client should read it, e.g. "WhatsApp bot"'),
      expected_value: z.number().min(0).optional().describe('Rupees'),
      source: z.enum(LEAD_SOURCES).optional(),
      owner_id: z.string().uuid().optional().describe('From list_team; default: the user'),
      notes: z.string().max(2000).optional(),
      allow_duplicate: z.boolean().optional(),
    },
    label: ({ name }) => `Added lead ${name}`,
    run: async (ctx, a) => {
      const l = await LeadsService.create(ctx.tenantId, ctx.access, {
        name: a.name, phone: a.phone, company: a.company ?? null, email: a.email ?? null, city: a.city ?? null, source: a.source ?? 'manual',
        service: a.interested_in ?? null, expectedValue: a.expected_value ?? null, notes: a.notes ?? null,
        ...(a.owner_id ? { ownerId: a.owner_id } : {}),
      }, a.allow_duplicate ?? false);
      return { created: true, id: l.id, name: l.name, stage: STAGE_LABELS[l.stage], owner: l.ownerName };
    },
  }),

  update_lead: tool({
    description: 'Change a lead\'s details, next follow-up time or automatic WhatsApp follow-ups. Send only the fields to change.',
    input: {
      lead_id: leadId,
      name: z.string().min(2).max(120).optional(),
      phone: z.string().min(6).max(25).optional(),
      company: z.string().max(160).optional(),
      email: z.string().email().max(255).optional(),
      city: z.string().max(80).optional(),
      interested_in: z.string().max(120).optional(),
      expected_value: z.number().min(0).optional(),
      owner_id: z.string().uuid().optional(),
      next_follow_up_at: when.optional(),
      auto_follow_up: z.boolean().optional().describe('Automatic WhatsApp follow-ups to the client at the follow-up time'),
      notes: z.string().max(2000).optional(),
    },
    label: () => 'Updated a lead',
    run: async (ctx, a) => {
      const l = await LeadsService.update(ctx.tenantId, ctx.access, a.lead_id, {
        name: a.name, phone: a.phone, company: a.company, email: a.email, city: a.city, service: a.interested_in,
        expectedValue: a.expected_value, ownerId: a.owner_id, nextFollowUpAt: a.next_follow_up_at, autoFollowUp: a.auto_follow_up, notes: a.notes,
      });
      return { updated: true, name: l.name, nextFollowUpAt: l.nextFollowUpAt, autoFollowUp: l.autoFollowUp };
    },
  }),

  move_lead: tool({
    description: [
      'Move a lead to another stage.',
      'requirement needs the requirement text; rejected needs reject_reason; accepted needs accept_as (bot = a bot service, added in the Partner admin panel; client = any other service, added to Clients).',
      'Moving to proposal needs a proposal on the lead (attach_proposal) and does NOT send anything; use prepare_proposal_whatsapp for that.',
    ].join(' '),
    input: {
      lead_id: leadId,
      stage: z.enum(LEAD_STAGES),
      requirement: z.string().max(4000).optional(),
      budget: z.string().max(80).optional(),
      timeline: z.string().max(80).optional(),
      reject_reason: z.enum(REJECT_REASONS).optional(),
      reject_note: z.string().max(1000).optional(),
      next_follow_up_at: when.optional(),
      accept_as: z.enum(['bot', 'client']).optional(),
    },
    label: ({ stage }) => `Moved a lead to ${STAGE_LABELS[stage]}`,
    run: async (ctx, a) => {
      const l = await LeadsService.moveStage(ctx.tenantId, ctx.access, a.lead_id, {
        stage: a.stage, requirement: a.requirement, budget: a.budget, timeline: a.timeline, rejectReason: a.reject_reason,
        rejectNote: a.reject_note, nextFollowUpAt: a.next_follow_up_at, acceptAs: a.accept_as,
      });
      return { moved: true, name: l.name, stage: STAGE_LABELS[l.stage], clientId: l.clientId };
    },
  }),

  add_lead_note: tool({
    description: 'Add a note to a lead\'s history (a call, a meeting, what the client said).',
    input: { lead_id: leadId, text: z.string().min(1).max(4000) },
    label: () => 'Added a note',
    run: async (ctx, { lead_id, text }) => {
      await LeadsService.addNote(ctx.tenantId, ctx.access, lead_id, text);
      return { added: true };
    },
  }),

  attach_proposal: tool({
    description: 'Save a file the user shared in this chat as a new proposal version on a lead (with the amount if known). Does not send it.',
    input: {
      lead_id: leadId,
      file_id: z.string().uuid().describe('The chat file id shown next to the shared file'),
      amount: z.number().min(0).optional().describe('Proposal amount in rupees, if stated'),
      note: z.string().max(1000).optional(),
    },
    label: () => 'Attached the proposal to the lead',
    run: async (ctx, a) => {
      const f = await chatFile(ctx, a.file_id);
      const list = await LeadsService.addProposalFromUpload(ctx.tenantId, ctx.access, a.lead_id, { id: f.uploadId!, name: f.name }, { amount: a.amount ?? null, note: a.note ?? null });
      return { attached: true, proposalId: list[0].id, version: list[0].version, file: f.name };
    },
  }),

  prepare_proposal_whatsapp: tool({
    description: [
      'Get a proposal ready to send to the lead on WhatsApp (the PDF with a short message saying it was emailed; no amount).',
      'This does NOT send: it shows the user a Send / Cancel card, and only their click sends it (and moves the lead to Proposal sent).',
      'Tell the user to check the card. Never say it was sent.',
    ].join(' '),
    input: { lead_id: leadId, proposal_version: z.number().int().min(1).optional().describe('Default: the latest') },
    label: () => 'Prepared the proposal for WhatsApp',
    run: async (ctx, a) => {
      const l = await LeadsService.get(ctx.tenantId, ctx.access, a.lead_id);
      const proposals = await LeadsService.proposals(ctx.tenantId, ctx.access, a.lead_id);
      const p = a.proposal_version ? proposals.find((x) => x.version === a.proposal_version) : proposals[0];
      if (!p) throw new LeadError(400, 'proposal', 'This lead has no proposal yet: attach one first');
      if (!p.file) throw new LeadError(400, 'file', `Proposal v${p.version} has no file; WhatsApp sends the file`);
      // One open card per proposal
      const [open] = await db.select({ id: aiActions.id }).from(aiActions).where(and(
        eq(aiActions.conversationId, ctx.conversationId), eq(aiActions.status, 'pending'), eq(aiActions.kind, 'send_proposal'),
      )).orderBy(desc(aiActions.createdAt)).limit(1);
      if (open) await db.update(aiActions).set({ status: 'cancelled', result: 'Replaced by a newer card', decidedAt: new Date() }).where(eq(aiActions.id, open.id));
      await db.insert(aiActions).values({
        tenantId: ctx.tenantId, conversationId: ctx.conversationId, userId: ctx.access.userId, kind: 'send_proposal',
        payload: { leadId: l.id, leadName: l.name, phone: formatLeadPhone(l.phone), proposalId: p.id, version: p.version, fileName: p.file.name, stage: l.stage },
      });
      return { waitingForUser: true, message: `A Send / Cancel card for proposal v${p.version} (${p.file.name}) to ${l.name} is shown to the user. It is sent only when they click Send.` };
    },
  }),
};

// Partner Panel wallets (LeadsNDeals): look-ups and top-up cards
Object.assign(AI_TOOLS, WALLET_TOOLS);

export type AiToolName = keyof typeof AI_TOOLS;


/** Tool definitions for Claude */
export function toolDefinitions(): Anthropic.Beta.BetaTool[] {
  return Object.entries(AI_TOOLS).map(([name, t]) => {
    const schema = z.toJSONSchema(z.object(t.input)) as Record<string, any>;
    delete schema.$schema;
    return { name, description: t.description, input_schema: schema as Anthropic.Beta.BetaTool.InputSchema };
  });
}
