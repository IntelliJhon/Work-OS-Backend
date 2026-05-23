import { pgTable, uuid, varchar, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const failedJobs = pgTable('failed_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  queueName: varchar('queue_name', { length: 255 }).notNull(),
  payload: jsonb('payload').notNull(),
  errorMessage: text('error_message').notNull(),
  retryCount: integer('retry_count').default(0).notNull(),
  failedAt: timestamp('failed_at').defaultNow().notNull(),
});

export type FailedJob = typeof failedJobs.$inferSelect;
export type NewFailedJob = typeof failedJobs.$inferInsert;
