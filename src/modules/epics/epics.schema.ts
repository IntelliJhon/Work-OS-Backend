import { z } from 'zod';

export const createEpicSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    status: z.enum(['to_do', 'in_progress', 'done']).optional(),
  }),
});

export const updateEpicSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    projectId: z.string().uuid().optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    status: z.enum(['to_do', 'in_progress', 'done']).optional(),
  }),
});
