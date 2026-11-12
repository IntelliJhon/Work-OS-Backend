import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Zoho Books REST API (v3) for the Billing section. One organization (ZOHO_ORG_ID), OAuth refresh token from a Self
 * Client; the short-lived access token is kept in memory and renewed a minute before it expires.
 */

export class ZohoError extends Error {
  constructor(public status: number, message: string, public code?: number) {
    super(message);
  }
}

export const zohoConfigured = () => Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN);

let cached: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

async function accessToken(): Promise<string> {
  if (!zohoConfigured()) throw new ZohoError(503, 'Zoho Books is not connected');
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  // One refresh at a time: Zoho limits how often a refresh token can be used
  refreshing ??= (async () => {
    const qs = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: env.ZOHO_REFRESH_TOKEN!, client_id: env.ZOHO_CLIENT_ID!, client_secret: env.ZOHO_CLIENT_SECRET!,
    });
    const res = await fetch(`${env.ZOHO_ACCOUNTS_URL.replace(/\/$/, '')}/oauth/v2/token?${qs}`, { method: 'POST', signal: AbortSignal.timeout(20_000) });
    const data: any = await res.json().catch(() => null);
    if (!data?.access_token) {
      logger.warn({ status: res.status, error: data?.error }, '[Zoho] Token refresh failed');
      throw new ZohoError(502, `Zoho Books login failed: ${data?.error ?? res.status}`);
    }
    cached = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return cached.token;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function url(path: string) {
  const sep = path.includes('?') ? '&' : '?';
  return `${env.ZOHO_API_BASE.replace(/\/$/, '')}${path}${sep}organization_id=${encodeURIComponent(env.ZOHO_ORG_ID)}`;
}

/** A JSON call; throws ZohoError with Zoho's message when Zoho answers with a non-zero code */
export async function zoho<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(url(path), {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!data || data.code !== 0) {
    const message = data?.message ?? `Zoho Books answered ${res.status}`;
    logger.warn({ method, path: path.split('?')[0], status: res.status, code: data?.code, message }, '[Zoho] Request failed');
    throw new ZohoError(res.status >= 400 && res.status < 500 ? 400 : 502, `Zoho Books: ${message}`, data?.code);
  }
  return data as T;
}

/** A document as a PDF (e.g. /customerpayments/{id} or /invoices/{id}) */
export async function zohoPdf(path: string): Promise<Buffer> {
  const res = await fetch(url(`${path}${path.includes('?') ? '&' : '?'}accept=pdf`), {
    headers: { Authorization: `Zoho-oauthtoken ${await accessToken()}` },
    signal: AbortSignal.timeout(30_000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buf.subarray(0, 4).toString() !== '%PDF') {
    logger.warn({ path, status: res.status, body: buf.subarray(0, 200).toString() }, '[Zoho] PDF download failed');
    throw new ZohoError(502, 'Zoho Books did not return the PDF');
  }
  return buf;
}
