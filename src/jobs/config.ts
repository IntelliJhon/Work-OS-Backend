import { RedisOptions, Redis } from 'ioredis';
import { env } from '../config/env';
import { MockRedis } from './mockRedis';

export const redisConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ
};

export const isRedisDisabled = process.env.DISABLE_REDIS === 'true';

// Export a shared Redis client for Health Checks and Rate Limiting
export const redisClient = isRedisDisabled
  ? new MockRedis() as any
  : new Redis(env.REDIS_URL, redisConnectionOptions);

