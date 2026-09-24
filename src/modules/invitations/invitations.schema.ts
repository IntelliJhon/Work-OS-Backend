import { z } from 'zod';

export const createInviteSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    roleId: z.string().uuid('Invalid Role ID'),
    // Optional WhatsApp number for work notifications, copied to the member on accept
    phone: z.string().max(25).nullable().optional(),
  }),
});

export const acceptInviteSchema = z.object({
  body: z.object({
    token: z.string(),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().min(1, 'Last name is required'),
  }),
});
