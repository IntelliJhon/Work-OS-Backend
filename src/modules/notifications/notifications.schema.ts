import { z } from 'zod';

export const readNotificationSchema = z.object({
  body: z.object({}).strict().optional(), // No body needed for reading, but good for validation structure
});
