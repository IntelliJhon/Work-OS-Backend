import { z } from 'zod';

export const createSprintSchema = z.object({
  body: z.object({
    activityId: z.string().uuid(),
    projectId: z.string().uuid(),
    name: z.string().min(1).max(255),
    status: z.enum(['planning', 'active', 'closed', 'cancelled']).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    cadenceType: z.enum(['WEEK', 'MONTH', 'CUSTOM']).optional(),
    cadenceInterval: z.number().int().positive().optional(),
    goal: z.string().optional(),
  }).refine((data) => {
    if (data.startDate && data.endDate) {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);
      return end.getTime() > start.getTime();
    }
    return true;
  }, {
    message: "endDate must be strictly after startDate",
    path: ["endDate"]
  }),
});

export const updateSprintSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    activityId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    name: z.string().min(1).max(255).optional(),
    status: z.enum(['planning', 'active', 'closed', 'cancelled']).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    cadenceType: z.enum(['WEEK', 'MONTH', 'CUSTOM']).optional(),
    cadenceInterval: z.number().int().positive().optional(),
    goal: z.string().optional(),
  }).refine((data) => {
    if (data.startDate && data.endDate) {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);
      return end.getTime() > start.getTime();
    }
    return true;
  }, {
    message: "endDate must be strictly after startDate",
    path: ["endDate"]
  }),
});
