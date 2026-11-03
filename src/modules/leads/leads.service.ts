import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  leadActivity, leadProposals, leads, LEAD_STAGES,
  type AcceptedAs, type LeadActivityKind, type LeadSource, type LeadStage, type RejectReason,
} from '../../db/schema/leads';
import { uploads } from '../../db/schema/uploads';
import { users } from '../../db/schema/users';
import { tenants } from '../../db/schema/tenants';
import { workspaceClients } from '../../db/schema/workspace_clients';
import { withTenant } from '../../middleware/tenant.middleware';
import { UploadService } from '../uploads/upload.service';
import { maskPhone, normalizePhone } from '../../lib/phone';
import { FILE_TYPES, baseType } from '../groups/groups.service';
import { ClientError, WorkspaceClientsService } from '../workspace-clients/workspace-clients.service';
import { WhatsAppBotsService } from '../whatsapp-bots/whatsapp-bots.service';
import { WhatsAppService } from '../../services/whatsapp.service';
import { everyRound } from '../../jobs/background-clock';
import { CLIENT_FOLLOW_UPS } from './follow-up-templates';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Leads: enquiries a workspace is trying to win, moved through stages on a board. Everyone with lead.read sees
 * leads and adds notes; Admins and roles with lead.manage add, edit and move them and add proposals; only Admins
 * archive and restore. Some stages need details first: a requirement, a proposal, or the reason it was rejected.
 */

export class LeadError extends Error {
  constructor(public status: number, public code: string, message: string, public data?: unknown) {
    super(message);
  }
}

export interface Access { userId: string; admin: boolean; read: boolean; manage: boolean }

type Lead = typeof leads.$inferSelect;
export interface LeadInput {
  name?: string;
  company?: string | null;
  phone?: string;
  email?: string | null;
  city?: string | null;
  source?: LeadSource;
  service?: string | null;
  expectedValue?: number | null;
  ownerId?: string | null;
  nextFollowUpAt?: string | null;
  autoFollowUp?: boolean;
  notes?: string | null;
  requirement?: string | null;
  budget?: string | null;
  timeline?: string | null;
}
export interface StageInput {
  stage: LeadStage;
  requirement?: string | null;
  budget?: string | null;
  timeline?: string | null;
  rejectReason?: RejectReason;
  rejectNote?: string | null;
  nextFollowUpAt?: string | null;
  autoFollowUp?: boolean;
  // Proposal sent: also send the latest proposal to the client on WhatsApp
  sendWhatsApp?: boolean;
  // Accepted: a bot client (added in the Partner admin panel) or another service (added to Clients)
  acceptAs?: AcceptedAs;
}

export interface WhatsAppResult { sent: boolean; error?: string }

export const LEAD_FILE_ENTITY = 'LEAD';
const ACTIVITY_PAGE = 50;
const HOUR = 3_600_000;
// A follow-up still not done this long after its time is reported once more as overdue
const OVERDUE_AFTER_MS = 24 * HOUR;
// Older follow-ups are not reminded about (e.g. the first round after this feature goes live)
const REMIND_WINDOW_MS = 7 * 24 * HOUR;

export const STAGE_LABELS: Record<LeadStage, string> = {
  new: 'Lead created',
  contacted: 'Contacted',
  requirement: 'Requirement collected',
  proposal: 'Proposal sent',
  follow_up: 'Follow up',
  accepted: 'Accepted',
  rejected: 'Rejected',
};
const REJECT_LABELS: Record<RejectReason, string> = {
  price: 'Price too high',
  timing: 'Not the right time',
  competitor: 'Went with someone else',
  no_response: 'Stopped responding',
  not_needed: 'No longer needed',
  other: 'Other',
};

const FIELD_LABELS: Record<keyof LeadInput, string> = {
  name: 'name',
  company: 'company',
  phone: 'WhatsApp number',
  email: 'email',
  city: 'city',
  source: 'source',
  service: 'interested in',
  expectedValue: 'expected value',
  ownerId: 'owner',
  nextFollowUpAt: 'next follow-up',
  autoFollowUp: 'automatic WhatsApp follow-ups',
  notes: 'about',
  requirement: 'requirement',
  budget: 'budget',
  timeline: 'timeline',
};

const fullName = (p: { firstName: string | null; lastName: string | null } | null | undefined) =>
  p ? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() : null;

const blankToNull = (v: string | null | undefined) => {
  if (v === undefined) return undefined;
  const t = (v ?? '').trim();
  return t ? t : null;
};

const money = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : v.toFixed(2));
const rupees = (v: string | number | null) => (v === null ? '' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

function listText(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

async function activeMember(tenantId: string, userId: string) {
  const [u] = await withTenant<{ id: string }[]>(tenantId, (tx) =>
    tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, userId), eq(users.tenantId, tenantId), isNull(users.deletedAt))).limit(1),
  );
  return u ?? null;
}

async function names(tenantId: string, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
    tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, wanted))),
  );
  return new Map(rows.map((r) => [r.id, fullName(r) ?? '']));
}

export class LeadsService {
  // ─── Access ───────────────────────────────────────────────────────────────────

  private static needRead(access: Access) {
    if (!access.read) throw new LeadError(403, 'forbidden', 'Your role cannot see leads');
  }

  private static needManage(access: Access) {
    if (!access.manage) throw new LeadError(403, 'forbidden', 'Your role cannot add or change leads');
  }

  private static async lead(tenantId: string, leadId: string, opts: { archived?: boolean } = {}): Promise<Lead> {
    const [l] = await db.select().from(leads).where(and(
      eq(leads.id, leadId),
      eq(leads.tenantId, tenantId),
      opts.archived ? undefined : isNull(leads.archivedAt),
    )).limit(1);
    if (!l) throw new LeadError(404, 'not_found', 'Lead not found');
    return l;
  }

  private static async log(tenantId: string, leadId: string, actorId: string, kind: LeadActivityKind, body: string | null, meta: Record<string, unknown> = {}) {
    await db.insert(leadActivity).values({ tenantId, leadId, actorId, kind, body, meta });
  }

  /** Live leads with this number (a returning enquiry is usually the same person) */
  private static async samePhone(tenantId: string, phone: string, exceptId?: string) {
    return db.select({ id: leads.id, name: leads.name, stage: leads.stage }).from(leads).where(and(
      eq(leads.tenantId, tenantId),
      isNull(leads.archivedAt),
      eq(leads.phone, phone),
      exceptId ? sql`${leads.id} <> ${exceptId}` : undefined,
    )).limit(5);
  }

  /** Validates and normalises the fields that were sent (name and phone are required on create) */
  private static async clean(tenantId: string, input: LeadInput, creating: boolean) {
    const out: Partial<typeof leads.$inferInsert> = {};
    if (input.name !== undefined || creating) {
      const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length < 2) throw new LeadError(400, 'name', 'Enter the lead\'s name');
      out.name = name;
    }
    if (input.phone !== undefined || creating) {
      const phone = normalizePhone(input.phone);
      if (!phone) throw new LeadError(400, 'phone', 'Enter a valid WhatsApp number, e.g. 98765 43210 or +91 98765 43210');
      out.phone = phone;
    }
    if (input.company !== undefined) out.company = blankToNull(input.company);
    if (input.email !== undefined) out.email = blankToNull(input.email)?.toLowerCase() ?? null;
    if (input.city !== undefined) out.city = blankToNull(input.city);
    if (input.source !== undefined) out.source = input.source;
    if (input.service !== undefined) out.service = blankToNull(input.service);
    if (input.expectedValue !== undefined) out.expectedValue = money(input.expectedValue);
    if (input.ownerId !== undefined) {
      if (input.ownerId && !(await activeMember(tenantId, input.ownerId))) {
        throw new LeadError(400, 'owner', 'The owner must be a member of this workspace');
      }
      out.ownerId = input.ownerId || null;
    }
    if (input.nextFollowUpAt !== undefined) out.nextFollowUpAt = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null;
    if (input.autoFollowUp !== undefined) out.autoFollowUp = input.autoFollowUp;
    if (input.notes !== undefined) out.notes = blankToNull(input.notes);
    if (input.requirement !== undefined) out.requirement = blankToNull(input.requirement);
    if (input.budget !== undefined) out.budget = blankToNull(input.budget);
    if (input.timeline !== undefined) out.timeline = blankToNull(input.timeline);
    return out;
  }

  private static async view(tenantId: string, l: Lead) {
    const people = await names(tenantId, [l.ownerId, l.createdBy, l.updatedBy]);
    return {
      ...l,
      ownerName: l.ownerId ? people.get(l.ownerId) ?? null : null,
      createdByName: l.createdBy ? people.get(l.createdBy) ?? null : null,
      updatedByName: l.updatedBy ? people.get(l.updatedBy) ?? null : null,
    };
  }

  // ─── Leads ────────────────────────────────────────────────────────────────────

  static async list(tenantId: string, access: Access, filter: { q?: string; ownerId?: string; source?: string; archived?: boolean } = {}) {
    this.needRead(access);
    const q = filter.q?.trim();
    const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const digits = q?.replace(/\D/g, '') ?? '';
    const rows = await db.select().from(leads).where(and(
      eq(leads.tenantId, tenantId),
      filter.archived ? isNotNull(leads.archivedAt) : isNull(leads.archivedAt),
      filter.ownerId === 'none' ? isNull(leads.ownerId) : filter.ownerId ? eq(leads.ownerId, filter.ownerId) : undefined,
      filter.source ? eq(leads.source, filter.source as LeadSource) : undefined,
      like ? or(
        ilike(leads.name, like),
        ilike(leads.company, like),
        ilike(leads.email, like),
        ilike(leads.city, like),
        ilike(leads.service, like),
        digits.length >= 4 ? ilike(leads.phone, `%${digits}%`) : undefined,
      ) : undefined,
    )).orderBy(desc(leads.stageChangedAt)).limit(2000);

    // Latest proposal per lead (version and amount), for the cards
    const ids = rows.map((r) => r.id);
    const latest = new Map<string, { version: number; amount: string | null; uploadId: string | null }>();
    if (ids.length) {
      const props = await db.selectDistinctOn([leadProposals.leadId], { leadId: leadProposals.leadId, version: leadProposals.version, amount: leadProposals.amount, uploadId: leadProposals.uploadId })
        .from(leadProposals)
        .where(and(eq(leadProposals.tenantId, tenantId), inArray(leadProposals.leadId, ids)))
        .orderBy(leadProposals.leadId, desc(leadProposals.version));
      props.forEach((p) => latest.set(p.leadId, { version: p.version, amount: p.amount, uploadId: p.uploadId }));
    }
    const people = await names(tenantId, rows.map((r) => r.ownerId));
    return rows.map((l) => ({
      id: l.id,
      name: l.name,
      company: l.company,
      phone: l.phone,
      email: l.email,
      city: l.city,
      source: l.source,
      service: l.service,
      expectedValue: l.expectedValue,
      stage: l.stage,
      stageChangedAt: l.stageChangedAt,
      ownerId: l.ownerId,
      ownerName: l.ownerId ? people.get(l.ownerId) ?? null : null,
      nextFollowUpAt: l.nextFollowUpAt,
      autoFollowUp: l.autoFollowUp,
      autoFollowUpsSent: l.autoFollowUpsSent,
      rejectReason: l.rejectReason,
      proposalVersion: latest.get(l.id)?.version ?? null,
      proposalAmount: latest.get(l.id)?.amount ?? null,
      proposalHasFile: !!latest.get(l.id)?.uploadId,
      clientId: l.clientId,
      archivedAt: l.archivedAt,
      createdAt: l.createdAt,
    }));
  }

  /** Workspace members, to pick the owner from */
  static async people(tenantId: string, access: Access) {
    this.needRead(access);
    const rows = await withTenant<{ id: string; firstName: string; lastName: string }[]>(tenantId, (tx) =>
      tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt))),
    );
    return rows.map((r) => ({ id: r.id, name: fullName(r) ?? '' })).sort((a, b) => a.name.localeCompare(b.name));
  }

  static async get(tenantId: string, access: Access, leadId: string) {
    this.needRead(access);
    return this.view(tenantId, await this.lead(tenantId, leadId, { archived: true }));
  }

  /** A number that is already on a live lead is refused unless allowDuplicate is set (the form asks first) */
  static async create(tenantId: string, access: Access, input: LeadInput, allowDuplicate = false) {
    this.needManage(access);
    const values = await this.clean(tenantId, input, true);
    if (!allowDuplicate) {
      const same = await this.samePhone(tenantId, values.phone!);
      if (same.length) {
        throw new LeadError(409, 'duplicate_phone', `${same[0].name} already has this number`, {
          leads: same.map((s) => ({ ...s, stageLabel: STAGE_LABELS[s.stage] })),
        });
      }
    }
    const [l] = await db.insert(leads).values({
      ...values,
      name: values.name!,
      phone: values.phone!,
      ownerId: values.ownerId === undefined ? access.userId : values.ownerId,
      tenantId,
      createdBy: access.userId,
      updatedBy: access.userId,
    }).returning();
    await this.log(tenantId, l.id, access.userId, 'created', `Added ${l.name}`);
    return this.view(tenantId, l);
  }

  static async update(tenantId: string, access: Access, leadId: string, input: LeadInput) {
    this.needManage(access);
    const before = await this.lead(tenantId, leadId);
    const values = await this.clean(tenantId, input, false);
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [key, value] of Object.entries(values) as [keyof LeadInput, unknown][]) {
      const old = (before as any)[key];
      const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);
      if (norm(old) !== norm(value)) changes[key] = [norm(old), norm(value)];
    }
    if (!Object.keys(changes).length) return this.view(tenantId, before);
    const [l] = await db.update(leads).set({ ...values, updatedBy: access.userId, updatedAt: new Date() })
      .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId))).returning();
    const fields = Object.keys(changes).map((k) => FIELD_LABELS[k as keyof LeadInput] ?? k);
    await this.log(tenantId, leadId, access.userId, 'updated', `Changed ${listText(fields)}`, { changes });
    return this.view(tenantId, l);
  }

  /**
   * Moves a lead to another stage. Requirement collected needs the requirement, Proposal sent needs a proposal,
   * Rejected needs a reason; anything else moves freely (backwards too).
   */
  static async moveStage(tenantId: string, access: Access, leadId: string, input: StageInput) {
    this.needManage(access);
    const before = await this.lead(tenantId, leadId);
    const to = input.stage;
    if (!LEAD_STAGES.includes(to)) throw new LeadError(400, 'stage', 'Unknown stage');
    const set: Partial<typeof leads.$inferInsert> = {};

    if (to === 'requirement') {
      const requirement = input.requirement !== undefined ? blankToNull(input.requirement) : before.requirement;
      if (!requirement) throw new LeadError(400, 'needs_requirement', 'Write down the requirement first');
      set.requirement = requirement;
      if (input.budget !== undefined) set.budget = blankToNull(input.budget);
      if (input.timeline !== undefined) set.timeline = blankToNull(input.timeline);
    }
    if (to === 'proposal') {
      const [p] = await db.select({ id: leadProposals.id }).from(leadProposals)
        .where(and(eq(leadProposals.leadId, leadId), eq(leadProposals.tenantId, tenantId))).limit(1);
      if (!p) throw new LeadError(400, 'needs_proposal', 'Add the proposal first');
    }
    if (to === 'accepted' && before.stage !== 'accepted') {
      if (!input.acceptAs) throw new LeadError(400, 'needs_accept_as', 'Choose whether it is a bot client or another service');
      set.acceptedAs = input.acceptAs;
    }
    if (to === 'rejected') {
      if (!input.rejectReason) throw new LeadError(400, 'needs_reason', 'Choose why it was rejected');
      set.rejectReason = input.rejectReason;
      set.rejectNote = blankToNull(input.rejectNote ?? null);
    } else if (before.stage === 'rejected') {
      set.rejectReason = null;
      set.rejectNote = null;
    }
    if (input.nextFollowUpAt !== undefined) set.nextFollowUpAt = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null;
    if (input.autoFollowUp !== undefined) set.autoFollowUp = input.autoFollowUp;
    // A closed lead has nothing to follow up
    if (to === 'accepted' || to === 'rejected') set.nextFollowUpAt = null;

    if (before.stage === to && !Object.keys(set).length && !input.sendWhatsApp) return this.view(tenantId, before);
    const [l] = await db.update(leads).set({
      ...set,
      stage: to,
      ...(before.stage !== to ? { stageChangedAt: new Date() } : {}),
      updatedBy: access.userId,
      updatedAt: new Date(),
    }).where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId))).returning();

    if (before.stage !== to) {
      const reason = to === 'rejected' && input.rejectReason
        ? ` (${REJECT_LABELS[input.rejectReason]}${set.rejectNote ? `: ${set.rejectNote}` : ''})` : '';
      await this.log(tenantId, leadId, access.userId, 'stage', `Moved from ${STAGE_LABELS[before.stage]} to ${STAGE_LABELS[to]}${reason}`, { from: before.stage, to });
    } else if (Object.keys(set).length) {
      await this.log(tenantId, leadId, access.userId, 'updated', `Updated ${STAGE_LABELS[to].toLowerCase()} details`);
    }

    let current = l;
    if (to === 'accepted' && before.stage !== 'accepted' && input.acceptAs === 'client' && !l.clientId) {
      current = await this.addAsClient(tenantId, access, l);
    } else if (to === 'accepted' && before.stage !== 'accepted' && input.acceptAs === 'bot') {
      await this.log(tenantId, leadId, access.userId, 'client', 'Bot client: add them in the Partner admin panel and they appear under Onboarded Clients');
    }
    let whatsapp: WhatsAppResult | undefined;
    // The move is done either way; a message that can't be sent is reported, not an error
    if (to === 'proposal' && input.sendWhatsApp) {
      whatsapp = await this.sendProposal(tenantId, access, leadId).catch((err) => {
        if (err instanceof LeadError) return { sent: false, error: err.message };
        throw err;
      });
    }
    return { ...(await this.view(tenantId, current)), ...(whatsapp ? { whatsapp } : {}) };
  }

  /** Accepted, not a bot client: the lead becomes a Client (or is linked to the client of the same name) */
  private static async addAsClient(tenantId: string, access: Access, l: Lead): Promise<Lead> {
    const name = l.company || l.name;
    let clientId: string;
    let created = true;
    try {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: env.WORK_TIMEZONE });
      const c = await WorkspaceClientsService.create(tenantId, { userId: access.userId, admin: access.admin, read: true, manage: true }, {
        name,
        contactPerson: l.company ? l.name : null,
        phone: l.phone,
        email: l.email,
        city: l.city,
        status: 'active',
        clientSince: today,
        notes: [l.service, l.requirement].filter(Boolean).join('\n\n') || null,
        tags: [],
      });
      clientId = c.id;
    } catch (err) {
      if (!(err instanceof ClientError && err.code === 'duplicate_name')) throw err;
      const [existing] = await db.select({ id: workspaceClients.id }).from(workspaceClients).where(and(
        eq(workspaceClients.tenantId, tenantId), isNull(workspaceClients.archivedAt), sql`lower(${workspaceClients.name}) = lower(${name})`,
      )).limit(1);
      clientId = existing.id;
      created = false;
    }
    const [updated] = await db.update(leads).set({ clientId, updatedAt: new Date() }).where(eq(leads.id, l.id)).returning();
    await this.log(tenantId, l.id, access.userId, 'client', created ? `Added ${name} to Clients` : `Linked to the existing client ${name}`, { clientId });
    return updated;
  }

  /** Sends a proposal version (default: the latest) to the client on WhatsApp, with its file as a document */
  static async sendProposal(tenantId: string, access: Access, leadId: string, proposalId?: string): Promise<WhatsAppResult> {
    this.needManage(access);
    const l = await this.lead(tenantId, leadId);
    const [p] = await db.select().from(leadProposals).where(and(
      eq(leadProposals.leadId, leadId), eq(leadProposals.tenantId, tenantId), proposalId ? eq(leadProposals.id, proposalId) : undefined,
    )).orderBy(desc(leadProposals.version)).limit(1);
    if (!p) throw new LeadError(404, 'not_found', 'Proposal not found');
    if (!p.uploadId) throw new LeadError(400, 'needs_file', 'Attach the proposal file first: WhatsApp sends the file to the client');

    const [upload] = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
      tx.select().from(uploads).where(and(eq(uploads.id, p.uploadId!), eq(uploads.tenantId, tenantId))).limit(1),
    );
    const wa = await WhatsAppBotsService.forTenant(tenantId);
    let result: WhatsAppResult;
    if (!upload) {
      result = { sent: false, error: 'The proposal file is missing' };
    } else {
      const url = await UploadService.getSignedDownloadUrl(tenantId, upload.id);
      const sent = await WhatsAppService.sendDocumentTemplate(l.phone, env.WHATSAPP_LEAD_PROPOSAL_TEMPLATE, wa.templates.lang,
        { url, filename: upload.originalName }, [l.name, l.service || 'our services'], wa.sender);
      result = sent.success ? { sent: true } : { sent: false, error: sent.error ?? 'WhatsApp did not accept the message' };
    }
    await db.update(leadProposals).set(result.sent ? { whatsappSentAt: new Date(), whatsappError: null } : { whatsappError: result.error ?? null })
      .where(eq(leadProposals.id, p.id));
    // A proposal the client just received starts the automatic follow-ups again
    if (result.sent) await db.update(leads).set({ autoFollowUpsSent: 0 }).where(eq(leads.id, leadId));
    await this.log(tenantId, leadId, access.userId, 'whatsapp',
      result.sent ? `Sent proposal v${p.version} to the client on WhatsApp` : `Proposal v${p.version} could not be sent on WhatsApp: ${result.error}`,
      { version: p.version, sent: result.sent });
    if (!result.sent) logger.warn({ leadId, to: maskPhone(l.phone), error: result.error }, '[Leads] Proposal WhatsApp failed');
    return result;
  }

  static async archive(tenantId: string, access: Access, leadId: string) {
    if (!access.admin) throw new LeadError(403, 'forbidden', 'Only Admins can archive leads');
    const l = await this.lead(tenantId, leadId);
    await db.update(leads).set({ archivedAt: new Date(), updatedBy: access.userId, updatedAt: new Date() }).where(eq(leads.id, l.id));
    await this.log(tenantId, l.id, access.userId, 'archived', `Archived ${l.name}`);
    return { archived: true };
  }

  static async restore(tenantId: string, access: Access, leadId: string) {
    if (!access.admin) throw new LeadError(403, 'forbidden', 'Only Admins can restore leads');
    const l = await this.lead(tenantId, leadId, { archived: true });
    if (!l.archivedAt) return this.view(tenantId, l);
    const [restored] = await db.update(leads).set({ archivedAt: null, updatedBy: access.userId, updatedAt: new Date() }).where(eq(leads.id, l.id)).returning();
    await this.log(tenantId, l.id, access.userId, 'restored', `Restored ${l.name}`);
    return this.view(tenantId, restored);
  }

  // ─── Notes and activity ─────────────────────────────────────────────────────

  static async activity(tenantId: string, access: Access, leadId: string, before?: string) {
    this.needRead(access);
    await this.lead(tenantId, leadId, { archived: true });
    const rows = await db.select().from(leadActivity).where(and(
      eq(leadActivity.leadId, leadId),
      eq(leadActivity.tenantId, tenantId),
      before ? lt(leadActivity.createdAt, new Date(before)) : undefined,
    )).orderBy(desc(leadActivity.createdAt)).limit(ACTIVITY_PAGE + 1);
    const people = await names(tenantId, rows.map((r) => r.actorId));
    const page = rows.slice(0, ACTIVITY_PAGE);
    return {
      items: page.map((r) => ({
        ...r,
        actorName: r.actorId ? people.get(r.actorId) ?? null : null,
        canDelete: r.kind === 'note' && (access.admin || r.actorId === access.userId),
      })),
      hasMore: rows.length > ACTIVITY_PAGE,
    };
  }

  /** Anyone who can see the lead can add a note (a call, a meeting, what the client said) */
  static async addNote(tenantId: string, access: Access, leadId: string, body: string) {
    this.needRead(access);
    await this.lead(tenantId, leadId);
    const text = body.trim();
    if (!text) throw new LeadError(400, 'note', 'Write the note first');
    const [row] = await db.insert(leadActivity).values({ tenantId, leadId, actorId: access.userId, kind: 'note', body: text }).returning();
    const people = await names(tenantId, [access.userId]);
    return { ...row, actorName: people.get(access.userId) ?? null, canDelete: true };
  }

  static async deleteNote(tenantId: string, access: Access, leadId: string, noteId: string) {
    this.needRead(access);
    const [note] = await db.select().from(leadActivity).where(and(
      eq(leadActivity.id, noteId), eq(leadActivity.leadId, leadId), eq(leadActivity.tenantId, tenantId), eq(leadActivity.kind, 'note'),
    )).limit(1);
    if (!note) throw new LeadError(404, 'not_found', 'Note not found');
    if (!access.admin && note.actorId !== access.userId) throw new LeadError(403, 'forbidden', 'You can only delete your own notes');
    await db.delete(leadActivity).where(eq(leadActivity.id, noteId));
    return { deleted: true };
  }

  // ─── Proposals ──────────────────────────────────────────────────────────────

  static async proposals(tenantId: string, access: Access, leadId: string) {
    this.needRead(access);
    await this.lead(tenantId, leadId, { archived: true });
    const rows = await db.select().from(leadProposals)
      .where(and(eq(leadProposals.leadId, leadId), eq(leadProposals.tenantId, tenantId)))
      .orderBy(desc(leadProposals.version));
    const files = new Map<string, { name: string; size: number; mimeType: string }>();
    const uploadIds = rows.map((r) => r.uploadId).filter((v): v is string => !!v);
    if (uploadIds.length) {
      const ups = await withTenant<(typeof uploads.$inferSelect)[]>(tenantId, (tx) =>
        tx.select().from(uploads).where(and(eq(uploads.tenantId, tenantId), inArray(uploads.id, uploadIds))),
      );
      ups.forEach((u) => files.set(u.id, { name: u.originalName, size: u.size, mimeType: u.mimeType }));
    }
    const people = await names(tenantId, rows.map((r) => r.createdBy));
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      amount: r.amount,
      note: r.note,
      file: r.uploadId ? files.get(r.uploadId) ?? null : null,
      uploadId: r.uploadId,
      whatsappSentAt: r.whatsappSentAt,
      whatsappError: r.whatsappError,
      createdAt: r.createdAt,
      createdByName: r.createdBy ? people.get(r.createdBy) ?? null : null,
    }));
  }

  /** A new proposal version: the file (PDF, Word…) and/or the amount */
  static async addProposal(tenantId: string, access: Access, leadId: string, input: { amount: number | null; note: string | null }, file?: Express.Multer.File) {
    this.needManage(access);
    const l = await this.lead(tenantId, leadId);
    if (!file && input.amount === null) throw new LeadError(400, 'proposal', 'Attach the proposal file or enter the amount');
    if (file && !FILE_TYPES.includes(baseType(file.mimetype))) {
      throw new LeadError(400, 'file_type', `"${file.originalname}" can't be added. Use PDF, images, Word, Excel or PowerPoint files.`);
    }
    const up = file ? await UploadService.processUpload({ tenantId, uploaderId: access.userId, entityType: LEAD_FILE_ENTITY, entityId: leadId, file }) : null;
    return this.saveProposal(tenantId, access, l, { uploadId: up?.id ?? null, fileName: file?.originalname ?? null, amount: input.amount, note: input.note });
  }

  /** A proposal from a file already uploaded to Work OS (e.g. shared in the AI assistant chat) */
  static async addProposalFromUpload(tenantId: string, access: Access, leadId: string, upload: { id: string; name: string }, input: { amount: number | null; note: string | null }) {
    this.needManage(access);
    const l = await this.lead(tenantId, leadId);
    return this.saveProposal(tenantId, access, l, { uploadId: upload.id, fileName: upload.name, amount: input.amount, note: input.note });
  }

  private static async saveProposal(tenantId: string, access: Access, l: Lead, input: { uploadId: string | null; fileName: string | null; amount: number | null; note: string | null }) {
    const leadId = l.id;
    const [{ next }] = await db.select({ next: sql<number>`coalesce(max(${leadProposals.version}), 0)::int + 1` }).from(leadProposals)
      .where(and(eq(leadProposals.leadId, leadId), eq(leadProposals.tenantId, tenantId)));
    const [p] = await db.insert(leadProposals).values({
      tenantId, leadId, version: next, amount: money(input.amount) ?? null, uploadId: input.uploadId, note: blankToNull(input.note) ?? null, createdBy: access.userId,
    }).returning();
    const what = [input.fileName, input.amount !== null ? rupees(input.amount) : null].filter(Boolean).join(', ');
    await this.log(tenantId, leadId, access.userId, 'proposal', `Added proposal v${p.version}${what ? ` (${what})` : ''}`, { version: p.version, amount: p.amount });
    await db.update(leads).set({ autoFollowUpsSent: 0 }).where(eq(leads.id, l.id));
    // The proposal amount is the best guess of the deal's value
    if (input.amount !== null) {
      await db.update(leads).set({ expectedValue: money(input.amount), updatedAt: new Date() }).where(eq(leads.id, l.id));
    }
    return this.proposals(tenantId, access, leadId);
  }

  static async proposalUrl(tenantId: string, access: Access, leadId: string, proposalId: string) {
    this.needRead(access);
    await this.lead(tenantId, leadId, { archived: true });
    const [p] = await db.select().from(leadProposals)
      .where(and(eq(leadProposals.id, proposalId), eq(leadProposals.leadId, leadId), eq(leadProposals.tenantId, tenantId))).limit(1);
    if (!p?.uploadId) throw new LeadError(404, 'not_found', 'This proposal has no file');
    return { url: await UploadService.getSignedDownloadUrl(tenantId, p.uploadId) };
  }

  // ─── Follow-ups at the follow-up time ─────────────────────────────────────

  /**
   * At a lead's follow-up time: the owner gets a WhatsApp reminder (and once more when it is still not updated a day
   * later), and a lead whose proposal is unanswered (Proposal sent / Follow up, auto follow-up on) gets the next
   * automatic follow-up about it. Each follow-up time is claimed before sending, so nothing goes out twice even
   * with two servers running.
   */
  static async remindFollowUps(now = new Date()) {
    const open = notInArray(leads.stage, ['accepted', 'rejected']);
    const due = await db.update(leads).set({ followUpRemindedFor: leads.nextFollowUpAt }).where(and(
      isNull(leads.archivedAt), open,
      lte(leads.nextFollowUpAt, now), gt(leads.nextFollowUpAt, new Date(now.getTime() - OVERDUE_AFTER_MS)),
      sql`${leads.followUpRemindedFor} is distinct from ${leads.nextFollowUpAt}`,
    )).returning();
    const overdue = await db.update(leads).set({ followUpOverdueFor: leads.nextFollowUpAt, followUpRemindedFor: leads.nextFollowUpAt }).where(and(
      isNull(leads.archivedAt), open, isNotNull(leads.ownerId),
      lte(leads.nextFollowUpAt, new Date(now.getTime() - OVERDUE_AFTER_MS)), gt(leads.nextFollowUpAt, new Date(now.getTime() - REMIND_WINDOW_MS)),
      sql`${leads.followUpOverdueFor} is distinct from ${leads.nextFollowUpAt}`,
    )).returning();
    const items = [...due.map((l) => ({ l, late: false })), ...overdue.map((l) => ({ l, late: true }))];
    if (!items.length) return;

    const byTenant = new Map<string, typeof items>();
    items.forEach((i) => byTenant.set(i.l.tenantId, [...(byTenant.get(i.l.tenantId) ?? []), i]));
    let clientMessages = 0;
    for (const [tenantId, list] of byTenant) {
      const ownerIds = list.map((i) => i.l.ownerId).filter((v): v is string => !!v);
      const owners = ownerIds.length ? await withTenant<{ id: string; firstName: string; phone: string | null }[]>(tenantId, (tx) =>
        tx.select({ id: users.id, firstName: users.firstName, phone: users.phone }).from(users)
          .where(and(eq(users.tenantId, tenantId), inArray(users.id, ownerIds), isNull(users.deletedAt))),
      ) : [];
      const ownerById = new Map(owners.map((o) => [o.id, o]));
      const wa = await WhatsAppBotsService.forTenant(tenantId);
      for (const { l, late } of list) {
        if (!late && await this.autoFollowUp(tenantId, l, wa)) clientMessages++;
        const owner = l.ownerId ? ownerById.get(l.ownerId) : undefined;
        if (!owner?.phone) continue;
        const at = l.nextFollowUpAt!.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: env.WORK_TIMEZONE });
        const about = [l.company, l.service].filter(Boolean).join(', ') || STAGE_LABELS[l.stage];
        const sent = await WhatsAppService.sendBodyTemplate(owner.phone, env.WHATSAPP_LEAD_FOLLOW_UP_TEMPLATE, wa.templates.lang,
          [owner.firstName, l.name, about, late ? `${at} (overdue)` : at], wa.sender);
        if (!sent.success) logger.warn({ leadId: l.id, to: maskPhone(owner.phone), error: sent.error }, '[Leads] Follow-up reminder failed');
      }
    }
    logger.info({ due: due.length, overdue: overdue.length, clientMessages }, '[Leads] Follow-ups sent');
  }

  /** The next automatic follow-up to the client about an unanswered proposal; true when one was sent */
  private static async autoFollowUp(tenantId: string, l: Lead, wa: Awaited<ReturnType<typeof WhatsAppBotsService.forTenant>>) {
    if (!l.autoFollowUp || (l.stage !== 'proposal' && l.stage !== 'follow_up')) return false;
    const step = CLIENT_FOLLOW_UPS[l.autoFollowUpsSent];
    if (!step) return false;
    const [proposal] = await db.select({ id: leadProposals.id }).from(leadProposals)
      .where(and(eq(leadProposals.leadId, l.id), eq(leadProposals.tenantId, tenantId))).limit(1);
    if (!proposal) return false;

    const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const sent = await WhatsAppService.sendBodyTemplate(l.phone, step.template, wa.templates.lang,
      [l.name, tenant?.name ?? 'our team', l.service || 'our services'], wa.sender);
    const n = l.autoFollowUpsSent + 1;
    const last = n === CLIENT_FOLLOW_UPS.length;
    if (!sent.success) {
      logger.warn({ leadId: l.id, to: maskPhone(l.phone), template: step.template, error: sent.error }, '[Leads] Client follow-up failed');
      await db.insert(leadActivity).values({ tenantId, leadId: l.id, actorId: null, kind: 'whatsapp',
        body: `Automatic follow-up ${n} of ${CLIENT_FOLLOW_UPS.length} (${step.label}) could not be sent on WhatsApp: ${sent.error}`, meta: { auto: true, step: n, sent: false } });
      return false;
    }
    await db.update(leads).set({
      autoFollowUpsSent: n,
      ...(l.stage === 'proposal' ? { stage: 'follow_up' as const, stageChangedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(leads.id, l.id));
    await db.insert(leadActivity).values({ tenantId, leadId: l.id, actorId: null, kind: 'whatsapp',
      body: `Sent automatic follow-up ${n} of ${CLIENT_FOLLOW_UPS.length} on WhatsApp: ${step.label}${last ? '. No more automatic follow-ups for this proposal.' : ''}`,
      meta: { auto: true, step: n, sent: true } });
    if (l.stage === 'proposal') {
      await db.insert(leadActivity).values({ tenantId, leadId: l.id, actorId: null, kind: 'stage',
        body: `Moved from ${STAGE_LABELS.proposal} to ${STAGE_LABELS.follow_up}`, meta: { from: 'proposal', to: 'follow_up', auto: true } });
    }
    return true;
  }
}

/** Follow-ups run with the other background checks (every 15 min, not at night) */
export function startLeadFollowUps() {
  everyRound('lead follow-ups', () => LeadsService.remindFollowUps());
}
