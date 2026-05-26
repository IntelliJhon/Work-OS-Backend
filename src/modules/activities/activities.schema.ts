import { z } from 'zod';

export const createActivitySchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    phaseId: z.string().uuid(),
    title: z.string().min(1).max(255),
    isSprintRelevant: z.boolean().default(false),
    frequency: z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']).optional().nullable(),
    startDate: z.string().datetime({ offset: true }).optional().nullable(),
    endDate: z.string().datetime({ offset: true }).optional().nullable(),
  }),
});

export const updateActivitySchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    projectId: z.string().uuid().optional(),
    phaseId: z.string().uuid().optional(),
    title: z.string().min(1).max(255).optional(),
    isSprintRelevant: z.boolean().optional(),
    frequency: z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']).optional().nullable(),
    startDate: z.string().datetime({ offset: true }).optional().nullable(),
    endDate: z.string().datetime({ offset: true }).optional().nullable(),
  }),
});
