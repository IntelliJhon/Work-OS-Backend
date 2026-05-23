import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';
import { redisConnectionOptions } from './config';

export const redisConnection = new Redis(env.REDIS_URL, redisConnectionOptions);

export const notificationsQueue = new Queue('notificationsQueue', { connection: redisConnection });
export const workflowQueue = new Queue('workflowQueue', { connection: redisConnection });
export const escalationQueue = new Queue('escalationQueue', { connection: redisConnection });
export const cleanupQueue = new Queue('cleanupQueue', { connection: redisConnection });
