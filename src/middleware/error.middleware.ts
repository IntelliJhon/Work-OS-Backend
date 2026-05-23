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

  return res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
  });
};
