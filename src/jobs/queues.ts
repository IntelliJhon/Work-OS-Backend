import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';
import { redisConnectionOptions, isRedisDisabled } from './config';
import { MockQueue, MockRedis } from './mockRedis';

export const redisConnection = isRedisDisabled
  ? new MockRedis() as any
  : new Redis(env.REDIS_URL, redisConnectionOptions);

export const notificationsQueue = isRedisDisabled
  ? new MockQueue('notificationsQueue') as any
  : new Queue('notificationsQueue', { connection: redisConnection });

export const workflowQueue = isRedisDisabled
  ? new MockQueue('workflowQueue') as any
  : new Queue('workflowQueue', { connection: redisConnection });

export const escalationQueue = isRedisDisabled
  ? new MockQueue('escalationQueue') as any
  : new Queue('escalationQueue', { connection: redisConnection });

export const cleanupQueue = isRedisDisabled
  ? new MockQueue('cleanupQueue') as any
  : new Queue('cleanupQueue', { connection: redisConnection });

