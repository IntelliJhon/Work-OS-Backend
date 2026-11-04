import { z } from 'zod';
import { db } from '../../db';
import { aiActions } from '../../db/schema/ai_assistant';
import { lowBalanceWatch } from '../../db/schema/low_balance_alerts';
import { env } from '../../config/env';
import { isLeadsndealsTenant } from '../../middleware/company.middleware';
import { LeadError } from '../leads/leads.service';
import { fetchAgencyWallets, fetchPartnerChannels, fetchPartnerUsers } from '../clients/partner-channels';
import { MAX_TOPUP } from '../clients/wallet-topups';
import type { ToolContext } from './ai-tools';

/**
 * Partner Panel wallets for the assistant (LeadsNDeals workspace only): look up clients' main and conversation
 * wallets and the agency's own balances, and get a top-up ready. A top-up is only a card: it is added when an Admin
 * clicks Add, through the same code as the Add balance buttons on Onboarded Clients.
 */

const money = (n: number, currency = 'INR') => `${currency === 'INR' ? '₹' : `${currency} `}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function needLeadsndeals(ctx: ToolContext) {
  if (!isLeadsndealsTenant(ctx.tenantId)) throw new LeadError(403, 'workspace', 'Partner Panel wallets are only available in the LeadsNDeals workspace');
}

const clientId = z.string().regex(/^[a-f0-9]{24}$/i).describe('The client id from find_client_wallets');

export const WALLET_TOOLS = {
  find_client_wallets: {
    description: [
      'Partner Panel clients with their main wallet and the conversation wallet of each active WhatsApp number, subscription expiry and whether low-balance alerts are on.',
      `Search by name or email, or set low_only for clients with a conversation wallet below ₹${env.LOW_BALANCE_LIMIT}. Use before preparing a top-up.`,
    ].join(' '),
    input: { query: z.string().max(100).optional(), low_only: z.boolean().optional() },
    label: ({ query, low_only }: { query?: string; low_only?: boolean }) => (low_only ? 'Looked up low client balances' : query ? `Looked up wallets for "${query}"` : 'Looked up client wallets'),
    run: async (ctx: ToolContext, a: { query?: string; low_only?: boolean }) => {
      needLeadsndeals(ctx);
      const [users, channels, watch] = await Promise.all([fetchPartnerUsers(), fetchPartnerChannels(), db.select({ userId: lowBalanceWatch.userId }).from(lowBalanceWatch)]);
      const watched = new Set(watch.map((w) => w.userId));
      const q = a.query?.trim().toLowerCase();
      const now = Date.now();
      const rows = users
        .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
        .map((u) => {
          const own = channels.filter((c) => c.userId === u.id && c.active);
          return {
            client_id: u.id,
            name: u.name,
            email: u.email,
            subscription_expiry: u.expiry,
            subscription_expired: u.expiry ? new Date(u.expiry).getTime() <= now : true,
            main_wallet: money(u.balance, u.currency),
            conversation_wallets: own.map((c) => ({ channel_id: c.id, number: c.number, channel: c.name, balance: money(c.balance, c.currency), low: c.balance < env.LOW_BALANCE_LIMIT })),
            low_balance_alert: watched.has(u.id),
          };
        })
        .filter((r) => !a.low_only || r.conversation_wallets.some((c) => c.low));
      return { count: rows.length, clients: rows.slice(0, 25) };
    },
  },

  get_agency_wallets: {
    description: 'The agency\'s own Partner Panel wallets that client top-ups are paid from: the main wallet (rupees) and the conversation wallet (coins).',
    input: {},
    label: () => 'Checked our Partner Panel wallets',
    run: async (ctx: ToolContext) => {
      needLeadsndeals(ctx);
      const w = await fetchAgencyWallets();
      return {
        main_wallet: w.main ? { balance: money(w.main.balance, w.main.currency), total_added: money(w.main.totalIn), total_spent: money(w.main.totalOut) } : null,
        conversation_wallet: w.conversation ? `${w.conversation.balance.toLocaleString('en-IN', { maximumFractionDigits: 2 })} coins` : null,
      };
    },
  },

  prepare_wallet_topup: {
    description: [
      'Get a top-up ready for a client: their main wallet, or the conversation wallet of one of their active WhatsApp numbers (channel_id from find_client_wallets).',
      'This does NOT add anything: it shows the user an Add / Cancel card, and only an Admin\'s click adds the balance in the Partner Panel.',
      'Only for Admins. Ask which number if the client has several and the user did not say. Never say the balance was added unless a "[Work OS]" note says so.',
    ].join(' '),
    input: {
      client_id: clientId,
      wallet: z.enum(['main', 'conversation']),
      channel_id: z.string().regex(/^[a-f0-9]{24}$/i).optional().describe('Required for a conversation wallet'),
      amount: z.number().positive().max(MAX_TOPUP).describe('Amount to add'),
      note: z.string().max(500).optional(),
    },
    label: ({ amount, wallet }: { amount: number; wallet: string }) => `Prepared a top-up of ${money(amount)} (${wallet} wallet)`,
    run: async (ctx: ToolContext, a: { client_id: string; wallet: 'main' | 'conversation'; channel_id?: string; amount: number; note?: string }) => {
      needLeadsndeals(ctx);
      if (!ctx.access.admin) throw new LeadError(403, 'forbidden', 'Only Admins can add balance');
      const users = await fetchPartnerUsers();
      const u = users.find((x) => x.id === a.client_id);
      if (!u) throw new LeadError(404, 'client', 'Client not found in the Partner Panel');
      let channel: { id: string; number: string; balance: number; currency: string } | undefined;
      if (a.wallet === 'conversation') {
        if (!a.channel_id) throw new LeadError(400, 'channel', 'Choose which WhatsApp number (channel_id) to top up');
        channel = (await fetchPartnerChannels()).find((c) => c.id === a.channel_id && c.userId === u.id && c.active);
        if (!channel) throw new LeadError(404, 'channel', 'That WhatsApp number is not an active channel of this client');
      }
      const current = channel ? channel.balance : u.balance;
      const currency = channel ? channel.currency : u.currency;
      await db.insert(aiActions).values({
        tenantId: ctx.tenantId, conversationId: ctx.conversationId, userId: ctx.access.userId, kind: 'wallet_topup',
        payload: {
          clientId: u.id, clientName: u.name, wallet: a.wallet, channelId: channel?.id ?? null, channelNumber: channel?.number ?? null,
          amount: a.amount, note: a.note ?? null, currentBalance: current, currency, leadId: null, leadName: u.name,
        },
      });
      return { waitingForUser: true, message: `An Add / Cancel card for ${money(a.amount, currency)} to ${u.name}'s ${a.wallet === 'main' ? 'main wallet' : `conversation wallet (${channel!.number})`} is shown. Nothing is added until an Admin clicks Add.` };
    },
  },
};
