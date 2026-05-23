import { RedisOptions, Redis } from 'ioredis';
import { env } from '../config/env';

export const redisConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ
};

// Export a shared Redis client for Health Checks and Rate Limiting
export const redisClient = new Redis(env.REDIS_URL, redisConnectionOptions);
