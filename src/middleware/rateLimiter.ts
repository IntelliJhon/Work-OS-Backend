import rateLimit from 'express-rate-limit';
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

// Global Rate Limiter: Environment-configurable limit, defaults to 5000 requests per 15 minutes
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.GLOBAL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Auth Rate Limiter: Environment-configurable limit, defaults to 500 requests per 15 minutes
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Upload Rate Limiter: Max uploads per minute (10 requests per minute)
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});
