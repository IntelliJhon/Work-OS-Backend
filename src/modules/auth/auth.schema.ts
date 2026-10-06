import { z } from 'zod';

export const loginSchema = z.object({
  body: z.object({
    workspace: z.string().min(3),
    email: z.string().email(),
    password: z.string(),
  }),
});

export const refreshSchema = z.object({
  // The token normally arrives in the HttpOnly cookie; the body is only for sessions from before that
  body: z.object({
    refreshToken: z.string().optional(),
  }).optional(),
});

export const logoutSchema = z.object({
  // The token normally arrives in the HttpOnly cookie; the body is only for sessions from before that
  body: z.object({
    refreshToken: z.string().optional(),
  }).optional(),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    workspace: z.string().min(3),
    email: z.string().email(),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    resetToken: z.string().min(10),
    newPassword: z.string().min(6),
  }),
});

