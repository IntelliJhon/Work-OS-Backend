import { z } from 'zod';

export const createProjectActivitySchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    title: z.string().min(1).max(255),
    workHrs: z.number().min(0),
  }),
});
