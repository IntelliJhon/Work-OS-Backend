import { z } from 'zod';

export const createProjectSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    overview: z.string().optional(),
    scopes: z.string().optional(),
    pmId: z.string().uuid().optional(),
    status: z.enum(['active', 'archived', 'completed']).optional(),
  }),
});

export const updateProjectSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    overview: z.string().optional(),
    scopes: z.string().optional(),
    pmId: z.string().uuid().optional(),
    status: z.enum(['active', 'archived', 'completed']).optional(),
  }),
});
