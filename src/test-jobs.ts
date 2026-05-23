import { db } from './db';
import { notificationsQueue } from './jobs/queues';
import { notificationRetryPolicy } from './jobs/retry/retryPolicy';
import { JobPayload } from './jobs/types';
import { tenants } from './db/schema/tenants';
import { users } from './db/schema/users';
import { failedJobs } from './db/schema/failed_jobs';
import { notifications } from './db/schema/notifications';
import { logger } from './config/logger';
import { startWorkers } from './jobs/workers';
import { eq } from 'drizzle-orm';

async function run() {
  try {
    logger.info('Starting Background Jobs Validation...');

    // 1. Get a valid tenant and user or create mock ones
    let tenantList = await db.select().from(tenants).limit(1);
    let tenant;
    if (!tenantList.length) {
      logger.info('No tenants found. Creating mock tenant...');
      const [newTenant] = await db.insert(tenants).values({
        name: 'Mock Tenant',
        slug: 'mock-tenant-' + Date.now(),
      }).returning();
      tenant = newTenant;
    } else {
      tenant = tenantList[0];
    }

    const { withTenant } = require('./middleware/tenant.middleware');
    let user = await withTenant(tenant.id, async (tx: any) => {
      let userList = await tx.select().from(users).where(eq(users.tenantId, tenant.id)).limit(1);
      if (!userList.length) {
        logger.info('No users found. Creating mock role and user...');
        const { roles } = require('./db/schema/roles');
        const [newRole] = await tx.insert(roles).values({
          tenantId: tenant.id,
          name: 'Mock Admin',
          permissions: {},
        }).returning();
        
        const [newUser] = await tx.insert(users).values({
          tenantId: tenant.id,
          email: 'test@mock.com',
          passwordHash: 'dummy',
          firstName: 'Test',
          lastName: 'User',
          roleId: newRole.id,
        }).returning();
        return newUser;
      }
      return userList[0];
    });

    logger.info(`Using Tenant: ${tenant.id}, User: ${user.id}`);

    // 2. Enqueue a successful notification job
    const successPayload: JobPayload = {
      tenantId: tenant.id,
      actorId: user.id,
      entityType: 'USER',
      entityId: user.id,
      metadata: {
        title: 'Test Success',
        body: 'This job should process successfully and create a notification.'
      },
      createdAt: new Date().toISOString()
    };
    
    const successJob = await notificationsQueue.add('test-success', successPayload, notificationRetryPolicy);
    logger.info(`✅ Enqueued Success Job ID: ${successJob.id}`);

    // 3. Enqueue a failing notification job to test retries and dead-letter
    const failPayload: JobPayload = {
      tenantId: tenant.id,
      actorId: user.id,
      entityType: 'USER',
      entityId: user.id,
      metadata: {
        forceFail: true // Triggers the intentional failure in worker
      },
      createdAt: new Date().toISOString()
    };
    
    // Using a fast retry policy for testing so we don't wait 15 seconds
    const fastRetryPolicy = {
      attempts: 3,
      backoff: {
        type: 'fixed',
        delay: 1000 // 1 second
      }
    };
    const failJob = await notificationsQueue.add('test-fail', failPayload, fastRetryPolicy);
    logger.info(`🚨 Enqueued Failing Job ID: ${failJob.id}`);

    // 4. Start workers to process the queue
    startWorkers();
    logger.info('⏳ Waiting for workers to process jobs (10s)...');
    
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // 5. Assertions
    logger.info('🔍 Running Assertions...');
    
    await withTenant(tenant.id, async (tx: any) => {
      // Check if notification was created for success job
      const createdNotification = await tx.select().from(notifications).where(eq(notifications.tenantId, tenant.id)).limit(1);
      if (createdNotification.length > 0) {
        logger.info('✅ SUCCESS: Notification job processed and inserted into DB correctly via withTenant!');
      } else {
        logger.error('❌ FAILURE: Notification was not created.');
      }

      // Check if failed job made it to dead letter table
      const failedLog = await tx.select().from(failedJobs).where(eq(failedJobs.queueName, 'notificationsQueue'));
      if (failedLog.length > 0) {
        logger.info(`✅ SUCCESS: Failed job was successfully routed to failed_jobs dead-letter table after retries!`);
      } else {
        logger.error('❌ FAILURE: Failed job was NOT routed to dead-letter table.');
      }
    });

    logger.info('🎉 Validation Complete.');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Validation Script Error');
    process.exit(1);
  }
}

run();
