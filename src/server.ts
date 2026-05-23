import app from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { initSocket } from './socket';
import { startWorkers } from './jobs/workers';
import { initializeSchedulers } from './jobs/schedulers';

const server = app.listen(env.PORT, async () => {
  logger.info(`🚀 Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  
  // Start background jobs
  startWorkers();
  await initializeSchedulers();
});

// Initialize Socket.IO with the HTTP server
initSocket(server);

process.on('unhandledRejection', (err: any) => {
  logger.error({ err }, 'Unhandled Rejection');
  server.close(() => process.exit(1));
});
