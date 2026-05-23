import { z } from 'zod';

export const createUserSchema = z.object({
  body: z.object({
    email: z.string().email().max(255),
    password: z.string().min(8).max(100),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    roleId: z.string().uuid(),
    twoFaEnabled: z.boolean().optional(),
  }),
});

export const updateUserSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    roleId: z.string().uuid().optional(),
    twoFaEnabled: z.boolean().optional(),
  }),
});
