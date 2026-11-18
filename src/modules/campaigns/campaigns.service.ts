import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  CAMPAIGN_PARAMS, campaignBatches, campaignEnrolments, campaignMessages, campaignOptouts, campaignSequences, campaignSteps,
  type CampaignParam, type EnrolmentKind, type StopReason,
} from '../../db/schema/campaigns';
import { leadActivity, leads } from '../../db/schema/leads';
import { clientEnquiries } from '../../db/schema/client_enquiries';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { normalizePhone } from '../../lib/phone';
import { WhatsAppService } from '../../services/whatsapp.service';
import { everyRound } from '../../jobs/background-clock';

/**
 * Category campaigns. Each category can have a sequence of approved WhatsApp templates (Day 1, 3, 7, 15, 30, then
 * every N days), sent through WAAU's Bulk Campaign API. Leads and Enquiry List contacts with that category join it automatically when they are added (or get
 * the category), or in bulk from the Campaigns page. Messages go out with the background clock in working hours.
 *
 * A contact's sequence stops when they reply, tap a button (Interested / Book a demo → the sales team is alerted and the
 * lead moves on; Not interested → never messaged again), send STOP, or the lead is accepted, rejected or archived.
 * Replies arrive from the WAAU bot's n8n flow through POST /api/integrations/campaign-reply.
 */

export class CampaignError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const DAY = 24 * 3600 * 1000;
// Messages only go out between these local hours (WORK_TIMEZONE)
const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 19;
// At most this many contacts per background round (every 15 min); each message goes out as one WAAU bulk campaign
const MAX_PER_ROUND = 500;

const localHour = (d: Date) => Number(d.toLocaleString('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: env.WORK_TIMEZONE }));
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

type Contact = { kind: EnrolmentKind; refId: string; phone: string | null; name: string | null; company?: string | null; category: string | null; subcategory?: string | null };

// ─── Sequences ────────────────────────────────────────────────────────────────

export interface StepInput { day: number; templateName: string; language?: string; params?: string[] }

export class CampaignsService {
  static async listSequences(tenantId: string) {
    const seqs = await db.select().from(campaignSequences).where(eq(campaignSequences.tenantId, tenantId)).orderBy(asc(campaignSequences.category));
    const ids = seqs.map((s) => s.id);
    const steps = ids.length ? await db.select().from(campaignSteps).where(inArray(campaignSteps.sequenceId, ids)).orderBy(asc(campaignSteps.day)) : [];
    const counts = ids.length ? await db.select({
      sequenceId: campaignEnrolments.sequenceId, status: campaignEnrolments.status, reason: campaignEnrolments.stopReason, n: sql<number>`count(*)::int`,
    }).from(campaignEnrolments).where(inArray(campaignEnrolments.sequenceId, ids))
      .groupBy(campaignEnrolments.sequenceId, campaignEnrolments.status, campaignEnrolments.stopReason) : [];
    const reports = ids.length ? await db.select({
      sequenceId: campaignBatches.sequenceId, recipients: sql<number>`sum(${campaignBatches.recipients})::int`, delivered: sql<number>`sum(${campaignBatches.delivered})::int`,
      read: sql<number>`sum(${campaignBatches.read})::int`, replied: sql<number>`sum(${campaignBatches.replied})::int`, failed: sql<number>`sum(${campaignBatches.failed})::int`,
    }).from(campaignBatches).where(inArray(campaignBatches.sequenceId, ids)).groupBy(campaignBatches.sequenceId) : [];
    return seqs.map((s) => {
      const mine = counts.filter((c) => c.sequenceId === s.id);
      const rep = reports.find((r) => r.sequenceId === s.id);
      const stopped: Record<string, number> = {};
      for (const c of mine) if (c.status === 'stopped' && c.reason) stopped[c.reason] = (stopped[c.reason] ?? 0) + c.n;
      return {
        ...s,
        steps: steps.filter((st) => st.sequenceId === s.id),
        stats: {
          active: mine.filter((c) => c.status === 'active').reduce((a, c) => a + c.n, 0),
          paused: mine.filter((c) => c.status === 'paused').reduce((a, c) => a + c.n, 0),
          stopped,
          // WAAU report totals (all messages sent so far)
          messages: { sent: rep?.recipients ?? 0, delivered: rep?.delivered ?? 0, read: rep?.read ?? 0, replied: rep?.replied ?? 0, failed: rep?.failed ?? 0 },
        },
      };
    });
  }

  /** Creates or updates a category's sequence and replaces its steps */
  static async saveSequence(tenantId: string, userId: string, input: { id?: string; category: string; active: boolean; repeatEveryDays: number | null; steps: StepInput[] }) {
    const category = input.category.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!category) throw new CampaignError(400, 'category', 'Choose the category');
    const steps = input.steps
      .map((s) => ({ day: Math.round(s.day), templateName: s.templateName.trim(), language: (s.language || 'en').trim(), params: (s.params ?? []).filter((p): p is CampaignParam => (CAMPAIGN_PARAMS as readonly string[]).includes(p)) }))
      .filter((s) => s.templateName);
    if (!steps.length) throw new CampaignError(400, 'steps', 'Add at least one message');
    if (steps.some((s) => s.day < 1 || s.day > 365)) throw new CampaignError(400, 'day', 'Days go from 1 to 365');
    if (new Set(steps.map((s) => s.day)).size !== steps.length) throw new CampaignError(400, 'day', 'Two messages are on the same day');
    if (steps.some((s) => !/^[a-z0-9_]{1,120}$/.test(s.templateName))) throw new CampaignError(400, 'template', 'Template names use small letters, numbers and _ (as in WAAU)');
    const repeat = input.repeatEveryDays && input.repeatEveryDays > 0 ? Math.min(Math.round(input.repeatEveryDays), 365) : null;

    const sameCategory = await db.select({ id: campaignSequences.id }).from(campaignSequences)
      .where(and(eq(campaignSequences.tenantId, tenantId), sql`lower(${campaignSequences.category}) = ${lc(category)}`)).limit(1);
    if (sameCategory[0] && sameCategory[0].id !== input.id) throw new CampaignError(409, 'duplicate', `${category} already has a sequence`);

    let id = input.id;
    if (id) {
      const [s] = await db.update(campaignSequences).set({ category, active: input.active, repeatEveryDays: repeat, updatedAt: new Date() })
        .where(and(eq(campaignSequences.id, id), eq(campaignSequences.tenantId, tenantId))).returning();
      if (!s) throw new CampaignError(404, 'not_found', 'Sequence not found');
      await db.delete(campaignSteps).where(eq(campaignSteps.sequenceId, id));
    } else {
      const [s] = await db.insert(campaignSequences).values({ tenantId, category, active: input.active, repeatEveryDays: repeat, createdBy: userId }).returning();
      id = s.id;
    }
    await db.insert(campaignSteps).values(steps.map((s) => ({ sequenceId: id!, ...s })));
    return (await this.listSequences(tenantId)).find((s) => s.id === id)!;
  }

  static async deleteSequence(tenantId: string, id: string) {
    await db.delete(campaignSequences).where(and(eq(campaignSequences.id, id), eq(campaignSequences.tenantId, tenantId)));
    return { deleted: true };
  }

  // ─── Enrolment ──────────────────────────────────────────────────────────────

  /**
   * Puts a lead or enquiry contact into its category's active sequence (if any). Skipped when the number opted out,
   * already has an active sequence, or already went through this one.
   */
  static async enrol(tenantId: string, c: Contact): Promise<'enrolled' | 'skipped'> {
    const phone = normalizePhone(c.phone);
    if (!phone || !c.category?.trim()) return 'skipped';
    const [seq] = await db.select().from(campaignSequences).where(and(
      eq(campaignSequences.tenantId, tenantId), eq(campaignSequences.active, true), sql`lower(${campaignSequences.category}) = ${lc(c.category)}`,
    )).limit(1);
    if (!seq) return 'skipped';
    const [opt] = await db.select().from(campaignOptouts).where(and(eq(campaignOptouts.tenantId, tenantId), eq(campaignOptouts.phone, phone))).limit(1);
    if (opt) return 'skipped';
    const [existing] = await db.select({ id: campaignEnrolments.id }).from(campaignEnrolments).where(and(
      eq(campaignEnrolments.tenantId, tenantId), eq(campaignEnrolments.phone, phone),
      sql`(${campaignEnrolments.status} <> 'stopped' or ${campaignEnrolments.sequenceId} = ${seq.id})`,
    )).limit(1);
    if (existing) return 'skipped';
    await db.insert(campaignEnrolments).values({
      tenantId, sequenceId: seq.id, kind: c.kind, refId: c.refId, phone,
      name: c.name?.slice(0, 160) ?? null, company: c.company?.slice(0, 160) ?? null,
      // The campaign's own spelling of the category (contacts may have typed it differently)
      category: seq.category, subcategory: c.subcategory?.slice(0, 80) ?? null,
      nextSendAt: new Date(),
    });
    return 'enrolled';
  }

  /** Never throws: called after a lead or enquiry is saved */
  static enrolQuietly(tenantId: string, c: Contact) {
    void this.enrol(tenantId, c).catch((err) => logger.warn({ err: err?.message, refId: c.refId }, '[Campaigns] Enrol failed'));
  }

  /** Puts every open lead and enquiry contact of the sequence's category in it (Campaigns page) */
  static async enrolExisting(tenantId: string, sequenceId: string) {
    const [seq] = await db.select().from(campaignSequences).where(and(eq(campaignSequences.id, sequenceId), eq(campaignSequences.tenantId, tenantId))).limit(1);
    if (!seq) throw new CampaignError(404, 'not_found', 'Sequence not found');
    if (!seq.active) throw new CampaignError(409, 'inactive', 'Switch the sequence on first');
    const cat = lc(seq.category);
    const leadRows = await db.select().from(leads).where(and(
      eq(leads.tenantId, tenantId), isNull(leads.archivedAt), sql`lower(${leads.category}) = ${cat}`, sql`${leads.stage} not in ('accepted','rejected')`,
    ));
    const enquiryRows = await db.select().from(clientEnquiries).where(and(eq(clientEnquiries.tenantId, tenantId), sql`lower(${clientEnquiries.category}) = ${cat}`));
    let enrolled = 0;
    for (const l of leadRows) if (await this.enrol(tenantId, { kind: 'lead', refId: l.id, phone: l.phone, name: l.name, company: l.company, category: l.category, subcategory: l.subcategory }) === 'enrolled') enrolled++;
    for (const e of enquiryRows) if (await this.enrol(tenantId, { kind: 'enquiry', refId: e.id, phone: e.number, name: e.clientName, category: e.category, subcategory: e.subcategory }) === 'enrolled') enrolled++;
    return { enrolled, checked: leadRows.length + enquiryRows.length };
  }

  static async listEnrolments(tenantId: string, filter: { status?: string; sequenceId?: string; refId?: string }) {
    const rows = await db.select().from(campaignEnrolments).where(and(
      eq(campaignEnrolments.tenantId, tenantId),
      filter.status ? eq(campaignEnrolments.status, filter.status as any) : undefined,
      filter.sequenceId ? eq(campaignEnrolments.sequenceId, filter.sequenceId) : undefined,
      filter.refId ? eq(campaignEnrolments.refId, filter.refId) : undefined,
    )).orderBy(desc(campaignEnrolments.enrolledAt)).limit(500);
    return rows;
  }

  static async setEnrolmentStatus(tenantId: string, id: string, action: 'pause' | 'resume' | 'stop') {
    const [e] = await db.select().from(campaignEnrolments).where(and(eq(campaignEnrolments.id, id), eq(campaignEnrolments.tenantId, tenantId))).limit(1);
    if (!e) throw new CampaignError(404, 'not_found', 'Not found');
    if (e.status === 'stopped') throw new CampaignError(409, 'stopped', 'This sequence has already stopped');
    const set = action === 'pause' ? { status: 'paused' as const }
      : action === 'resume' ? { status: 'active' as const, nextSendAt: e.nextSendAt && e.nextSendAt > new Date() ? e.nextSendAt : new Date() }
        : { status: 'stopped' as const, stopReason: 'manual' as const, stoppedAt: new Date(), nextSendAt: null };
    const [u] = await db.update(campaignEnrolments).set(set).where(eq(campaignEnrolments.id, id)).returning();
    return u;
  }

  // ─── Sending ────────────────────────────────────────────────────────────────

  private static async stopEnrolment(id: string, reason: StopReason) {
    await db.update(campaignEnrolments).set({ status: 'stopped', stopReason: reason, stoppedAt: new Date(), nextSendAt: null })
      .where(and(eq(campaignEnrolments.id, id), sql`${campaignEnrolments.status} <> 'stopped'`));
  }

  /** Still worth messaging? (lead not converted/lost/archived, enquiry not deleted, number not opted out) */
  private static async stillOpen(e: typeof campaignEnrolments.$inferSelect): Promise<StopReason | null> {
    const [opt] = await db.select().from(campaignOptouts).where(and(eq(campaignOptouts.tenantId, e.tenantId), eq(campaignOptouts.phone, e.phone))).limit(1);
    if (opt) return 'opted_out';
    if (e.kind === 'lead') {
      const [l] = await db.select({ stage: leads.stage, archivedAt: leads.archivedAt }).from(leads).where(eq(leads.id, e.refId)).limit(1);
      if (!l || l.archivedAt) return 'removed';
      if (l.stage === 'accepted') return 'converted';
      if (l.stage === 'rejected') return 'lost';
    } else {
      const [q] = await db.select({ id: clientEnquiries.id }).from(clientEnquiries).where(eq(clientEnquiries.id, e.refId)).limit(1);
      if (!q) return 'removed';
    }
    return null;
  }

  /** WAAU Bulk Campaign API: one campaign to many numbers, each with its own variables */
  private static async waau(method: string, path: string, body?: unknown): Promise<any> {
    const base = (env.CRM_API_URL || 'https://crmapi.waau.in/api/meta').replace(/\/api\/meta\/?$/, '').replace(/\/$/, '');
    const res = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { 'API-KEY': env.CRM_API_ACCESS_TOKEN ?? '', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || data?.success === false) throw new Error(String(data?.message || data?.error || data?.data || `WAAU answered ${res.status}`).slice(0, 300));
    return data;
  }

  static async sendDue() {
    const now = new Date();
    const hour = localHour(now);
    if (hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR) await this.sendRound(now);
    await this.refreshReports().catch((err) => logger.warn({ err: err?.message }, '[Campaigns] Report refresh failed'));
  }

  /**
   * Everyone due now, grouped by message (sequence + step): each group goes out as one WAAU bulk campaign.
   * The group is marked sent once WAAU accepts the campaign; a refused one is retried a few hours later.
   */
  private static async sendRound(now: Date) {
    const due = await db.select().from(campaignEnrolments).where(and(
      eq(campaignEnrolments.status, 'active'), lte(campaignEnrolments.nextSendAt, now),
    )).orderBy(asc(campaignEnrolments.nextSendAt)).limit(MAX_PER_ROUND);
    if (!due.length) return;
    const seqIds = [...new Set(due.map((d) => d.sequenceId))];
    const seqs = new Map((await db.select().from(campaignSequences).where(inArray(campaignSequences.id, seqIds))).map((s) => [s.id, s]));
    const steps = await db.select().from(campaignSteps).where(inArray(campaignSteps.sequenceId, seqIds)).orderBy(asc(campaignSteps.day));

    const groups = new Map<string, { seq: typeof campaignSequences.$inferSelect; step: typeof campaignSteps.$inferSelect; list: typeof due }>();
    for (const e of due) {
      const seq = seqs.get(e.sequenceId);
      if (!seq?.active) continue; // switched off: wait
      const closed = await this.stillOpen(e);
      if (closed) { await this.stopEnrolment(e.id, closed); continue; }
      const mine = steps.filter((s) => s.sequenceId === e.sequenceId);
      if (!mine.length) continue;
      if (e.stepsSent >= mine.length && !seq.repeatEveryDays) { await this.stopEnrolment(e.id, 'finished'); continue; }
      // After the last step: repeat it every N days
      const step = mine[Math.min(e.stepsSent, mine.length - 1)];
      const key = `${seq.id}:${step.id}`;
      if (!groups.has(key)) groups.set(key, { seq, step, list: [] });
      groups.get(key)!.list.push(e);
    }

    let sent = 0;
    for (const { seq, step, list } of groups.values()) {
      const mine = steps.filter((s) => s.sequenceId === seq.id);
      const params = step.params as CampaignParam[];
      const receivers = list.map((e) => ({
        to: e.phone,
        variables: { name: e.name || 'there', company: e.company || e.name || '-', category: e.category || '-', subcategory: e.subcategory || e.category || '-' },
      }));
      const day = new Date(now).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: env.WORK_TIMEZONE });
      let waauId: string | null = null;
      let error: string | null = null;
      try {
        const r = await this.waau('POST', '/crm/campaign', {
          receivers,
          title: `Work OS · ${seq.category} · Day ${step.day} · ${day}`.slice(0, 120),
          channel: env.WAAU_CAMPAIGN_CHANNEL_ID,
          action: 'trigger',
          mode: 'immediate',
          schedule: 0,
          messages: [{
            type: 'template',
            template: {
              language: { policy: 'deterministic', code: step.language || 'en' },
              name: step.templateName,
              components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: `{{${p}}}` })) }] : [],
            },
          }],
        });
        waauId = String(r?.id ?? r?.data?._id ?? r?.data?.id ?? '') || null;
      } catch (err) {
        error = err instanceof Error ? err.message : 'Not sent';
      }

      if (error) {
        for (const e of list) {
          await db.insert(campaignMessages).values({ enrolmentId: e.id, day: step.day, templateName: step.templateName, kind: 'failed', error });
          // Try again in a few hours
          await db.update(campaignEnrolments).set({ lastError: error, nextSendAt: new Date(Date.now() + 6 * 3600 * 1000) }).where(eq(campaignEnrolments.id, e.id));
        }
        logger.warn({ sequence: seq.category, template: step.templateName, count: list.length, error }, '[Campaigns] Bulk campaign refused');
        continue;
      }

      const [batch] = await db.insert(campaignBatches).values({
        tenantId: seq.tenantId, sequenceId: seq.id, day: step.day, templateName: step.templateName, waauCampaignId: waauId, recipients: list.length,
      }).returning();
      for (const e of list) {
        sent++;
        const stepsSent = e.stepsSent + 1;
        const next = mine[stepsSent];
        const nextSendAt = next
          ? new Date(e.enrolledAt.getTime() + (next.day - 1) * DAY)
          : seq.repeatEveryDays ? new Date(now.getTime() + seq.repeatEveryDays * DAY) : null;
        await db.insert(campaignMessages).values({ batchId: batch.id, enrolmentId: e.id, day: step.day, templateName: step.templateName, kind: 'sent' });
        await db.update(campaignEnrolments).set({ stepsSent, lastSentAt: now, lastError: null, nextSendAt, ...(nextSendAt ? {} : { status: 'stopped' as const, stopReason: 'finished' as const, stoppedAt: now }) })
          .where(eq(campaignEnrolments.id, e.id));
        if (e.kind === 'lead') {
          await db.insert(leadActivity).values({ tenantId: e.tenantId, leadId: e.refId, actorId: null, kind: 'whatsapp', body: `${e.category} campaign: sent the Day ${step.day} message (${step.templateName})`, meta: { via: 'campaign', waauCampaignId: waauId } });
        }
      }
      logger.info({ sequence: seq.category, day: step.day, recipients: list.length, waauId }, '[Campaigns] Bulk campaign sent');
    }
    if (sent) logger.info({ due: due.length, sent }, '[Campaigns] Messages sent');
  }

  /** WAAU report counts for campaigns sent in the last 3 days (at most once an hour each) */
  private static async refreshReports() {
    const since = new Date(Date.now() - 3 * DAY);
    const stale = new Date(Date.now() - 3600 * 1000);
    const batches = await db.select().from(campaignBatches).where(and(
      sql`${campaignBatches.waauCampaignId} is not null`, sql`${campaignBatches.createdAt} >= ${since}`,
      sql`(${campaignBatches.reportAt} is null or ${campaignBatches.reportAt} < ${stale})`,
    )).limit(10);
    for (const b of batches) {
      const r = await this.waau('GET', `/crm/campaign/${encodeURIComponent(b.waauCampaignId!)}/report`).catch(() => null);
      const rows: any[] = Array.isArray(r?.report) ? r.report : [];
      const sum = (k: string) => rows.reduce((a, x) => a + (Number(x?.report?.[k]) || 0), 0);
      await db.update(campaignBatches).set({ sent: sum('sent'), delivered: sum('delivered'), read: sum('read'), replied: sum('replied'), failed: sum('failed'), reportAt: new Date() })
        .where(eq(campaignBatches.id, b.id));
    }
  }

  // ─── Replies ────────────────────────────────────────────────────────────────

  /**
   * A reply or button tap from a contact (from the WAAU bot's n8n flow). Stops their sequence; buttons:
   * Interested / Book a demo → alert the sales team and move the lead on (an enquiry becomes a lead);
   * Not interested or STOP → opted out for good.
   */
  static async handleReply(tenantId: string, input: { phone: string; text?: string | null; button?: string | null }) {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new CampaignError(400, 'phone', 'Invalid number');
    const active = await db.select().from(campaignEnrolments).where(and(
      eq(campaignEnrolments.tenantId, tenantId), eq(campaignEnrolments.phone, phone), sql`${campaignEnrolments.status} <> 'stopped'`,
    ));
    if (!active.length) return { handled: false as const };
    const said = (input.button || input.text || '').trim();
    const t = lc(said);
    const kind: StopReason = /not\s*interested|^no thanks?$/.test(t) ? 'not_interested'
      : /^(stop|unsubscribe|opt ?out)$/.test(t) ? 'opted_out'
        : /book.*demo|^demo$/.test(t) ? 'demo'
          : /^interested$|^yes,? (i'?m )?interested/.test(t) ? 'interested'
            : 'replied';

    for (const e of active) {
      await this.stopEnrolment(e.id, kind);
      await db.insert(campaignMessages).values({ enrolmentId: e.id, day: 0, templateName: '-', kind: 'reply', text: said.slice(0, 1000) || null });
    }
    if (kind === 'not_interested' || kind === 'opted_out') {
      await db.insert(campaignOptouts).values({ tenantId, phone, reason: kind }).onConflictDoNothing();
    }
    const e = active[0];
    const label = kind === 'demo' ? 'Book a demo' : kind === 'interested' ? 'Interested' : kind === 'not_interested' ? 'Not interested' : kind === 'opted_out' ? 'STOP' : 'a reply';

    // The lead this is about (an enquiry that shows interest becomes a lead)
    let leadId = active.find((a) => a.kind === 'lead')?.refId ?? null;
    if (!leadId && (kind === 'interested' || kind === 'demo')) {
      const { LeadsService } = await import('../leads/leads.service');
      const { lead } = await LeadsService.intake(tenantId, {
        phone, name: e.name, company: e.company, category: e.category, subcategory: e.subcategory,
        source: 'whatsapp', sourceLabel: `${e.category} campaign: ${label}`,
      });
      leadId = lead.id;
    }
    if (leadId) {
      const note = kind === 'replied' ? `Replied to the ${e.category} campaign: "${said.slice(0, 300)}"` : `Tapped "${label}" on the ${e.category} campaign`;
      await db.insert(leadActivity).values({ tenantId, leadId, actorId: null, kind: 'whatsapp', body: `${note}. Campaign messages stopped.`, meta: { via: 'campaign', reply: kind } });
      if (kind === 'interested' || kind === 'demo' || kind === 'replied') {
        const [l] = await db.select({ stage: leads.stage }).from(leads).where(eq(leads.id, leadId)).limit(1);
        if (l?.stage === 'new') {
          await db.update(leads).set({ stage: 'contacted', stageChangedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, leadId));
          await db.insert(leadActivity).values({ tenantId, leadId, actorId: null, kind: 'stage', body: 'Moved to Contacted (answered a campaign message)', meta: { via: 'campaign', from: 'new', to: 'contacted' } });
        }
      }
    }

    // Sales team: interest and demo requests
    if (kind === 'interested' || kind === 'demo') {
      const numbers = env.LOW_BALANCE_ALERT_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean);
      for (const to of numbers) {
        const r = await WhatsAppService.sendBodyTemplate(to, env.WHATSAPP_CAMPAIGN_SALES_TEMPLATE, env.WHATSAPP_WORK_TEMPLATE_LANG,
          [e.name || e.company || 'A contact', `+${phone}`, label, e.category || '-']);
        if (!r.success) logger.warn({ to, error: r.error }, '[Campaigns] Sales alert failed');
      }
    }
    logger.info({ phone: `…${phone.slice(-4)}`, kind, enrolments: active.length }, '[Campaigns] Reply handled');
    return { handled: true as const, action: kind, leadId };
  }
}

/** Sends due campaign messages with the other background checks (every 15 min, working hours only) */
export function startCampaigns() {
  everyRound('category campaigns', () => CampaignsService.sendDue());
}
