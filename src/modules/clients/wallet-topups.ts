import { db } from '../../db';
import { walletTopups } from '../../db/schema/low_balance_alerts';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Adds balance to a client's wallet through the Partner Panel API: the main (account) wallet, or one WhatsApp channel's
 * conversation wallet. Admins only (checked by the route). Every attempt is logged, done or failed.
 */

export class TopUpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MAX_TOPUP = 100_000;

const base = () => (env.AUTOMATIONS_BUILDER_API_BASE || 'https://partner-api.automationsbuilder.com').replace(/\/$/, '');
const headers = () => ({ Authorization: `Bearer ${env.AUTOMATIONS_BUILDER_API_TOKEN ?? ''}`, Accept: 'application/json', 'Content-Type': 'application/json' });

async function partner(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base()}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const data: any = await res.json().catch(() => null);
  return { ok: res.ok && data?.success !== false, status: res.status, data };
}

interface TopUpInput {
  tenantId: string;
  userId: string;
  clientId: string;
  clientName: string | null;
  amount: number;
  note: string | null;
}

async function log(input: TopUpInput, extra: { wallet: 'main' | 'conversation'; channelId?: string; channelNumber?: string; status: 'done' | 'failed'; error?: string | null }) {
  await db.insert(walletTopups).values({
    tenantId: input.tenantId, clientId: input.clientId, clientName: input.clientName, channelId: extra.channelId ?? null,
    channelNumber: extra.channelNumber ?? null, wallet: extra.wallet, amount: input.amount.toFixed(2), note: input.note,
    status: extra.status, error: extra.error ?? null, addedBy: input.userId,
  });
}

function checkAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new TopUpError(400, 'Enter an amount above zero');
  if (amount > MAX_TOPUP) throw new TopUpError(400, `At most ₹${MAX_TOPUP.toLocaleString('en-IN')} at a time`);
}

/** The client's main (account) wallet */
export async function topUpMainWallet(input: TopUpInput) {
  checkAmount(input.amount);
  const r = await partner('PUT', `/api/v1/user/${encodeURIComponent(input.clientId)}/wallet`, { action: 'deposit', value: input.amount });
  if (!r.ok) {
    const error = r.data?.message || r.data?.error || `Partner API answered ${r.status}`;
    await log(input, { wallet: 'main', status: 'failed', error });
    logger.warn({ clientId: input.clientId, status: r.status, error }, '[WalletTopUp] Main wallet top-up failed');
    throw new TopUpError(502, `The balance was not added: ${error}`);
  }
  await log(input, { wallet: 'main', status: 'done' });
  const after = await partner('GET', `/api/v1/user/${encodeURIComponent(input.clientId)}/wallet`);
  return { balance: typeof after.data?.data?.balance === 'number' ? after.data.data.balance : null };
}

/** One WhatsApp channel's conversation wallet; the channel must belong to the client */
export async function topUpConversationWallet(input: TopUpInput & { channelId: string }) {
  checkAmount(input.amount);
  const channel = await partner('GET', `/api/v1/crm/channel/${encodeURIComponent(input.channelId)}`);
  const ownerId = channel.data?.data?.user?._id ?? channel.data?.data?.user;
  if (!channel.ok || String(ownerId ?? '') !== input.clientId) throw new TopUpError(404, 'That WhatsApp channel does not belong to this client');
  const number = String(channel.data?.data?.basic_details?.channel_identity ?? '');
  const r = await partner('POST', `/api/v1/crm/channel/${encodeURIComponent(input.channelId)}/wallet`, { module: 'balance', action: 'deposit', balance: input.amount });
  if (!r.ok) {
    const error = r.data?.message || r.data?.error || `Partner API answered ${r.status}`;
    await log(input, { wallet: 'conversation', channelId: input.channelId, channelNumber: number, status: 'failed', error });
    logger.warn({ channelId: input.channelId, status: r.status, error }, '[WalletTopUp] Conversation wallet top-up failed');
    throw new TopUpError(502, `The balance was not added: ${error}`);
  }
  await log(input, { wallet: 'conversation', channelId: input.channelId, channelNumber: number, status: 'done' });
  const after = await partner('GET', `/api/v1/crm/channel/${encodeURIComponent(input.channelId)}`);
  return { balance: typeof after.data?.data?.wallet?.balance === 'number' ? after.data.data.wallet.balance : null };
}
