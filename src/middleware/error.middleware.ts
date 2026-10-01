import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, msg: 'Unhandled Error', path: req.path });

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation Error',
      details: err.issues,
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (err.status === 403) {
    return res.status(403).json({
      error: 'Forbidden',
      message: err.message || 'You are not allowed to update this task'
    });
  }

  const rawMessage = err.message || '';
  // Postgres refused the change (a record still in use, a duplicate, a missing value): not a connection problem
  const pgCode: string | undefined = err.code || err.cause?.code;
  if (pgCode && /^23/.test(pgCode)) {
    logger.warn({ code: pgCode, detail: err.cause?.detail || err.detail, constraint: err.cause?.constraint || err.constraint }, 'Database refused a change');
    const message = pgCode === '23505'
      ? 'This already exists.'
      : pgCode === '23503'
        ? 'This is still used by other records, so it cannot be removed or changed.'
        : 'The change could not be saved because some information is missing or invalid.';
    return res.status(409).json({ error: message, message, code: 'constraint_violation' });
  }
  const isDbOrNetworkError =
    rawMessage.includes('fetch failed') ||
    rawMessage.includes('ENOTFOUND') ||
    rawMessage.includes('ECONNREFUSED') ||
    rawMessage.includes('ETIMEDOUT') ||
    rawMessage.toLowerCase().includes('database');

  // Any other failed query: don't show SQL to the user
  if (!isDbOrNetworkError && (rawMessage.includes('Failed query:') || rawMessage.toLowerCase().includes('select "'))) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.', message: 'Something went wrong. Please try again.' });
  }

  if (isDbOrNetworkError) {
    return res.status(503).json({
      error: 'Unable to connect to database/server. Please check your internet connection and try again.',
      message: 'Unable to connect to database/server. Please check your internet connection and try again.',
    });
  }

  return res.status(err.status || 500).json({
    error: rawMessage || 'Internal Server Error',
    message: rawMessage || 'Internal Server Error',
  });
};
