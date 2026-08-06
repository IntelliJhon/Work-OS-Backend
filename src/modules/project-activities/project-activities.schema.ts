import { z } from 'zod';

export const createProjectActivitySchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    parentId: z.string().uuid().optional().nullable(),
    title: z.string().min(1).max(255),
    workHrs: z.number().min(0),
  }),
});

export const updateProjectActivitySchema = z.object({
  body: z.object({
    title: z.string().min(1).max(255).optional(),
    workHrs: z.number().min(0).optional(),
  }),
});
