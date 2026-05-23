import { logger as baseLogger } from '../../config/logger';

export const logger = baseLogger;
export const requestLogger = baseLogger.child({ domain: 'request' });
export const errorLogger = baseLogger.child({ domain: 'error' });
export const socketLogger = baseLogger.child({ domain: 'socket' });
export const jobLogger = baseLogger.child({ domain: 'job' });
export const workflowLogger = baseLogger.child({ domain: 'workflow' });
export const uploadLogger = baseLogger.child({ domain: 'upload' });
