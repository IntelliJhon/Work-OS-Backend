import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { isProduction } from '../../config/env';

// The refresh token lives in an HttpOnly cookie, so page scripts (and anything injected into the page) cannot read it.
// The frontend reaches /api/auth through its own domain (Vercel rewrite / Vite proxy), so this is a first-party cookie.
export const REFRESH_COOKIE = 'wos_rt';
const COOKIE_PATH = '/api/auth';

const baseOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict' as const,
  path: COOKIE_PATH,
});

export function setRefreshCookie(res: Response, token: string) {
  const exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions(), ...(exp ? { expires: new Date(exp * 1000) } : {}) });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, baseOptions());
}

/** The refresh token from the cookie; falls back to the request body for sessions started before the cookie existed. */
export function readRefreshToken(req: Request): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === REFRESH_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  const fromBody = req.body?.refreshToken;
  return typeof fromBody === 'string' && fromBody ? fromBody : undefined;
}

/** Moves the refresh token from a token response body into the cookie. */
export function sendSession<T extends { refreshToken?: string }>(res: Response, result: T, status = 200) {
  const { refreshToken, ...rest } = result;
  if (refreshToken) setRefreshCookie(res, refreshToken);
  return res.status(status).json(rest);
}
