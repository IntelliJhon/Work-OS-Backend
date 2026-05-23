import { JobsOptions } from 'bullmq';

export const notificationRetryPolicy: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000, // 5 seconds
  },
};

export const escalationRetryPolicy: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 10000, // 10 seconds
  },
};

export const cleanupRetryPolicy: JobsOptions = {
  attempts: 1, // Cleanups don't need retries
};

export const defaultRetryPolicy: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,
  },
};
