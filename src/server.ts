import app from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { initSocket } from './socket';
import { startWorkers } from './jobs/workers';
import { initializeSchedulers } from './jobs/schedulers';

import { startGoogleSheetPolling } from './modules/complaints/complaints.controller';
import { startTaskReminders } from './modules/calendar/task-reminders.service';
import { startLeaveEscalation } from './modules/leave/leave.service';
import { startDueReminders } from './modules/due-reminders/due-reminders.service';
import { startTimeLogReminders } from './modules/time-logs/time-logs.service';
import { startLocationNames } from './modules/attendance/location-names';
import { startLeadFollowUps } from './modules/leads/leads.service';
import { startLowBalanceAlerts } from './modules/clients/low-balance-alerts';

const server = app.listen(env.PORT, async () => {
  logger.info(`🚀 Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  
  // A server on someone's laptop that shares the live database leaves reminders and escalations to the live server
  if (env.BACKGROUND_JOBS_ENABLED === 'false') {
    logger.info('[Background] Background jobs are off (BACKGROUND_JOBS_ENABLED=false)');
    return;
  }

  // Start background jobs & Google Sheet complaint polling
  startWorkers();
  await initializeSchedulers();
  startGoogleSheetPolling();
  startTaskReminders();
  startLeaveEscalation();
  startDueReminders();
  startTimeLogReminders();
  startLocationNames();
  startLeadFollowUps();
  startLowBalanceAlerts();
});

// Initialize Socket.IO with the HTTP server
initSocket(server);

process.on('unhandledRejection', (err: any) => {
  logger.error({ err }, 'Unhandled Rejection');
  
  // Safely swallow Redis quota limits or connection failures without crashing the server process
  const errMsg = err?.message || '';
  if (
    errMsg.includes('max requests limit') || 
    errMsg.includes('Upstash') || 
    errMsg.includes('Redis') || 
    errMsg.includes('connection')
  ) {
    logger.warn('⚠️ Redis/BullMQ error detected. Keeping the server online safely.');
    return;
  }

  server.close(() => process.exit(1));
});
