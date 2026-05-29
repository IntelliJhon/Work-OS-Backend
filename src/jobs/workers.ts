import { Worker, Job } from 'bullmq';
import { redisConnection } from './queues';
import { JobPayload } from './types';
import { db } from '../db';
import { failedJobs } from '../db/schema/failed_jobs';
import { invitations } from '../db/schema/invitations';
import { withTenant } from '../middleware/tenant.middleware';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { logger } from '../config/logger';
import { lt, and, isNull, eq } from 'drizzle-orm';
import { isRedisDisabled } from './config';
import { MockWorker } from './mockRedis';

const WorkerClass = (isRedisDisabled ? MockWorker : Worker) as any;


// Utility to handle failures
const handleFailedJob = async (job: Job | undefined, err: Error, queueName: string) => {
  if (!job) return;
  logger.error(`❌ Job ${job.id} failed in ${queueName}: ${err.message}`);
  
  if (job.attemptsMade >= (job.opts.attempts || 1)) {
    try {
      await db.insert(failedJobs).values({
        queueName,
        payload: job.data,
        errorMessage: err.message,
        retryCount: job.attemptsMade,
      });
      logger.info(`⚰️ Job ${job.id} moved to dead-letter (failed_jobs)`);
    } catch (dbErr: any) {
      logger.error(`🚨 Failed to save dead-letter job ${job.id}: ${dbErr.message}`);
    }
  }
};

export const notificationsWorker = new WorkerClass(
  'notificationsQueue',
  async (job: any) => {
    logger.info(`Processing notification job ${job.id} for tenant ${job.data.tenantId}`);
    
    if (job.data.metadata?.forceFail) {
      throw new Error('Forced failure for testing');
    }

    if (job.data.tenantId !== 'system' && job.data.actorId) {
      await withTenant(job.data.tenantId, async (tx) => {
        await NotificationsService.notify({
          tenantId: job.data.tenantId,
          recipientUserId: job.data.actorId!,
          type: 'SYSTEM',
          title: job.data.metadata?.title || 'Background Job Finished',
          message: job.data.metadata?.body || `Job ${job.id} processed successfully.`,
          entityType: job.data.entityType,
          entityId: job.data.entityId
        }, tx);
      });
    }
  },
  { connection: redisConnection }
);
notificationsWorker.on('failed', (job: any, err: any) => handleFailedJob(job, err, 'notificationsQueue'));

export const workflowWorker = new WorkerClass(
  'workflowQueue',
  async (job: any) => {
    logger.info(`Processing workflow job ${job.id} for tenant ${job.data.tenantId}`);
    
    if (job.data.tenantId !== 'system') {
      await withTenant(job.data.tenantId, async (tx) => {
        logger.info(`Verified tenant isolation for workflow job ${job.id}`);
        // Additional workflow logic can be added here
      });
    }
  },
  { connection: redisConnection }
);
workflowWorker.on('failed', (job: any, err: any) => handleFailedJob(job, err, 'workflowQueue'));

export const escalationWorker = new WorkerClass(
  'escalationQueue',
  async (job: any) => {
    logger.info(`Processing escalation job ${job.id} for tenant ${job.data.tenantId}`);
  },
  { connection: redisConnection }
);
escalationWorker.on('failed', (job: any, err: any) => handleFailedJob(job, err, 'escalationQueue'));

export const cleanupWorker = new WorkerClass(
  'cleanupQueue',
  async (job: any) => {
    logger.info(`Processing cleanup job ${job.id} for tenant ${job.data.tenantId}`);
    try {
      const now = new Date();
      let deletedCount = 0;
      if (job.data.tenantId && job.data.tenantId !== 'system') {
        const result = await withTenant(job.data.tenantId, async (tx) => {
          return tx.delete(invitations)
            .where(
              and(
                eq(invitations.tenantId, job.data.tenantId),
                lt(invitations.expiresAt, now),
                isNull(invitations.acceptedAt)
              )
            ).returning();
        });
        deletedCount = result.length;
      } else {
        const result = await db.delete(invitations)
          .where(
            and(
              lt(invitations.expiresAt, now),
              isNull(invitations.acceptedAt)
            )
          ).returning();
        deletedCount = result.length;
      }
      logger.info(`🧹 Expired invitation cleanup completed. Deleted ${deletedCount} invitations.`);
    } catch (err: any) {
      logger.error(`Error during invitation cleanup: ${err.message}`);
    }
  },
  { connection: redisConnection }
);
cleanupWorker.on('failed', (job: any, err: any) => handleFailedJob(job, err, 'cleanupQueue'));

export const startWorkers = () => {
  logger.info('✅ Background workers started');
};
