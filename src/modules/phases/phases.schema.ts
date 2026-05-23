import { z } from 'zod';

export const createPhaseSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    name: z.string().min(1).max(100),
    orderIndex: z.number().int().min(0),
    status: z.enum(['pending', 'active', 'completed', 'blocked']).optional(),
    isLocked: z.boolean().optional(),
  }),
});

export const updatePhaseSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    projectId: z.string().uuid().optional(),
    name: z.string().min(1).max(100).optional(),
    orderIndex: z.number().int().min(0).optional(),
    status: z.enum(['pending', 'active', 'completed', 'blocked']).optional(),
    isLocked: z.boolean().optional(),
  }),
});
