import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { logger } from './config/logger';
import { errorHandler } from './middleware/error.middleware';
import { requestLogger, requestIdMiddleware } from './middleware/requestLogger';
import { globalLimiter } from './middleware/rateLimiter';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { redisClient } from './jobs/config';

import { authRouter } from './modules/auth/auth.routes';
import { tasksRouter } from './modules/tasks/tasks.routes';
import { tenantRouter } from './modules/tenants/tenant.routes';
import { usersRouter } from './modules/users/users.routes';
import { rolesRouter } from './modules/roles/roles.routes';
import { projectsRouter } from './modules/projects/projects.routes';
import { phasesRouter } from './modules/phases/phases.routes';
import { sprintsRouter } from './modules/sprints/sprints.routes';
import { activitiesRouter } from './modules/activities/activities.routes';
import { epicsRouter } from './modules/epics/epics.routes';
import { storiesRouter } from './modules/stories/stories.routes';
import { gatesRouter } from './modules/gates/gates.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { uploadsRouter } from './modules/uploads/upload.routes';
import { invitationsRouter } from './modules/invitations/invitations.routes';
import { auditRouter } from './modules/security/audit.routes';

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { notificationsQueue, workflowQueue, escalationQueue, cleanupQueue } from './jobs/queues';
import { isRedisDisabled } from './jobs/config';

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

const dashboardQueues = isRedisDisabled ? [] : [
  new BullMQAdapter(notificationsQueue as any),
  new BullMQAdapter(workflowQueue as any),
  new BullMQAdapter(escalationQueue as any),
  new BullMQAdapter(cleanupQueue as any),
];

createBullBoard({
  queues: dashboardQueues,
  serverAdapter,
});

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// Inject request ID and structured logging
app.use(requestIdMiddleware);
app.use(requestLogger);

// Global Rate Limiting
app.use(globalLimiter);

// Routes
app.use('/api/auth', authRouter);
app.use('/api/tenants', tenantRouter);
app.use('/api/users', usersRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/phases', phasesRouter);
app.use('/api/sprints', sprintsRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/epics', epicsRouter);
app.use('/api/stories', storiesRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/gates', gatesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/invitations', invitationsRouter);
app.use('/api/security', auditRouter);

// Background Jobs Dashboard
app.use('/admin/queues', serverAdapter.getRouter());

// Detailed Healthchecks
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health/database', async (req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ status: 'healthy', database: 'connected' });
  } catch (err: any) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', error: err.message });
  }
});

app.get('/health/redis', async (req, res) => {
  try {
    await redisClient.ping();
    res.json({ status: 'healthy', redis: 'connected' });
  } catch (err: any) {
    res.status(503).json({ status: 'unhealthy', redis: 'disconnected', error: err.message });
  }
});

app.get('/health/workers', (req, res) => {
  // Can be extended to check worker health statuses if needed
  res.json({ status: 'healthy', workers: 'running' });
});

// Error Handler
app.use(errorHandler);

export default app;
