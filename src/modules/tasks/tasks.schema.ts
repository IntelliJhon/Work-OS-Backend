import { z } from 'zod';

export const createTaskSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    storyId: z.string().uuid(),
    activityId: z.string().uuid().optional(),
    sprintId: z.string().uuid().nullable().optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    status: z.enum(['to_do', 'todo', 'in_progress', 'in_review', 'review', 'done', 'blocked']).default('to_do'),
    customFields: z.record(z.string(), z.any()).optional(),
  }),
});
