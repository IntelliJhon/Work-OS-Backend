import { z } from 'zod';

export const createRoleSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    permissions: z.record(z.string(), z.boolean()).optional(),
  }),
});

export const updateRoleSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    permissions: z.record(z.string(), z.boolean()).optional(),
  }),
});
