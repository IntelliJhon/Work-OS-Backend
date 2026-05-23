import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../jobs/config';
import { logger } from '../lib/logger';
import { Request, Response } from 'express';

import { env } from '../config/env';

// Reusable handler for rate limit exceeded
const handler = (req: Request, res: Response, next: any, options: any) => {
  logger.warn({ ip: req.ip, path: req.path }, 'Rate limit exceeded');
  res.status(options.statusCode).json({
    error: 'Rate limit exceeded',
    retryAfter: Math.ceil(options.windowMs / 1000),
    timestamp: new Date().toISOString()
  });
};

// Create a unique store for each limiter
const createStore = (prefix: string) => new RedisStore({
  // @ts-expect-error - Known typing mismatch between ioredis and rate-limit-redis
  sendCommand: (...args: string[]) => redisClient.call(args[0], ...args.slice(1)),
  prefix,
});

// Global Rate Limiter: Environment-configurable limit, defaults to 1000 requests per 15 minutes
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.GLOBAL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore('rl:global:'),
  handler,
});

// Auth Rate Limiter: Environment-configurable limit, defaults to 100 requests per 15 minutes
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore('rl:auth:'),
  handler,
});

// Upload Rate Limiter: Max uploads per minute (10 requests per minute)
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: createStore('rl:upload:'),
  handler,
});
