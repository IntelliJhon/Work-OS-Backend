import { env, isProduction } from './env';

/** Browser origins allowed to call the API: APP_URL, CORS_ORIGINS, and the local dev server outside production. */
export function allowedOrigins(): string[] {
  const list = [env.APP_URL, ...env.CORS_ORIGINS.split(',')]
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!isProduction) list.push('http://localhost:5173', 'http://127.0.0.1:5173');
  return [...new Set(list)];
}
