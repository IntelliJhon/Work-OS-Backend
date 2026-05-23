import { z } from 'zod';

export const loginSchema = z.object({
  body: z.object({
    workspace: z.string().min(3),
    email: z.string().email(),
    password: z.string(),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string(),
  }),
});

export const logoutSchema = z.object({
  body: z.object({
    refreshToken: z.string(),
  }),
});
