import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * The clients' WhatsApp channels from the Partner Panel API (read-only). Each channel has its own conversation wallet
 * (what WhatsApp messages are paid from); a client can have more than one channel.
 */

export interface PartnerChannel {
  id: string;
  userId: string | null;
  name: string;
  number: string;
  balance: number;
  currency: string;
  active: boolean;
}

const PAGE = 20;
const MAX_PAGES = 50;

export class PartnerApiError extends Error {
  constructor(public status: number) {
    super(`Partner API answered ${status}`);
  }
}

export async function fetchPartnerChannels(): Promise<PartnerChannel[]> {
  const base = (env.AUTOMATIONS_BUILDER_API_BASE || 'https://partner-api.automationsbuilder.com').replace(/\/$/, '');
  const out: PartnerChannel[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${base}/api/v1/crm/channel?page=${page}&limit=${PAGE}`, {
      headers: { Authorization: `Bearer ${env.AUTOMATIONS_BUILDER_API_TOKEN ?? ''}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new PartnerApiError(res.status);
    const json: any = await res.json();
    const batch: any[] = Array.isArray(json?.data) ? json.data : [];
    for (const c of batch) {
      out.push({
        id: String(c._id),
        userId: c.user?._id ? String(c.user._id) : null,
        name: c.basic_details?.name ?? 'WhatsApp channel',
        number: String(c.basic_details?.channel_identity ?? ''),
        balance: typeof c.wallet?.balance === 'number' ? c.wallet.balance : 0,
        currency: c.billing?.currency ?? 'INR',
        active: c.active === true && c.permanent_disabled !== true && c.is_banned !== true,
      });
    }
    if (batch.length < PAGE) break;
  }
  return out;
}

/** Active channels per client account */
export async function activeChannelsByUser(): Promise<Map<string, PartnerChannel[]>> {
  const byUser = new Map<string, PartnerChannel[]>();
  try {
    for (const c of await fetchPartnerChannels()) {
      if (!c.active || !c.userId) continue;
      byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);
    }
  } catch (err) {
    // The client list still loads without balances
    logger.warn({ err }, '[PartnerChannels] Could not load the conversation wallets');
  }
  return byUser;
}
