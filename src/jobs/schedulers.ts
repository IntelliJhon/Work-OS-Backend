import { workflowQueue, escalationQueue, cleanupQueue } from './queues';
import { JobPayload } from './types';

export const initializeSchedulers = async () => {
  // Gate Scheduler: Runs hourly
  await workflowQueue.add('gate-scheduler', {
    tenantId: 'system',
    entityType: 'scheduler',
    createdAt: new Date().toISOString()
  } as JobPayload, {
    repeat: {
      pattern: '0 * * * *', // hourly
    },
    jobId: 'gate-scheduler',
  });

  // Sprint Scheduler: Runs hourly
  await escalationQueue.add('sprint-scheduler', {
    tenantId: 'system',
    entityType: 'scheduler',
    createdAt: new Date().toISOString()
  } as JobPayload, {
    repeat: {
      pattern: '0 * * * *',
    },
    jobId: 'sprint-scheduler',
  });

  // Cleanup Scheduler: Runs daily at midnight
  await cleanupQueue.add('cleanup-scheduler', {
    tenantId: 'system',
    entityType: 'scheduler',
    createdAt: new Date().toISOString()
  } as JobPayload, {
    repeat: {
      pattern: '0 0 * * *',
    },
    jobId: 'cleanup-scheduler',
  });

  console.log('✅ Background job schedulers initialized');
};
