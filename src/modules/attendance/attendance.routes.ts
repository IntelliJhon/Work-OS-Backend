import { Router, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { AttendanceError, AttendanceService, isRealDay, localParts } from './attendance.service';
import { checkSection, SectionsService } from '../sections/sections.service';
import { allows, roleAccess } from '../sections/role-access';

export const ATTENDANCE_PERMISSIONS = {
  // See everyone's attendance (Admins; Project Managers by default)
  READ: 'attendance.read',
  // Correct entries, set leave and holidays, change the rules (Admins)
  MANAGE: 'attendance.manage',
  // Checks in and is counted (everyone by default; a role without it is not counted)
  USE: 'attendance.use',
} as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.string().refine(isRealDay, 'Invalid date');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const checkInSchema = z.object({
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  accuracy: z.number().min(0).max(1_000_000).nullish(),
  locationStatus: z.enum(['ok', 'denied', 'unavailable']).nullish(),
});
const correctSchema = z.object({
  userId: z.string().uuid(),
  day,
  status: z.enum(['present', 'late', 'absent', 'leave']),
  early: z.boolean().optional(),
  reason: z.string().trim().min(2).max(500),
});
const leaveSchema = z.object({ userId: z.string().uuid(), from: day, to: day, reason: z.string().trim().min(2).max(500) });
const holidaySchema = z.object({ day, name: z.string().trim().min(2).max(120) });
const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  earlyBefore: time.optional(),
  lateAfter: time.optional(),
  checkInFrom: time.optional(),
  absentAfter: time.optional(),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
});

export const attendanceRouter = Router();
attendanceRouter.use(authenticate as any);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Validation Error', details: err.issues });
    if (err instanceof AttendanceError) return res.status(err.status).json({ error: err.message, code: err.code });
    return next(err);
  }
}) as any;

// POST /api/attendance/check-in - the day's first check-in (the app calls it on every visit; idempotent)
attendanceRouter.post('/check-in', handle(async (req, res) => {
  const body = checkInSchema.parse(req.body ?? {});
  // Not counted: the workspace has Attendance off, or the person's role doesn't use it
  if (!(await SectionsService.isEnabled(req.user!.tenantId, 'attendance'))
    || !allows(await roleAccess(req.user!.tenantId, req.user!.roleId), ATTENDANCE_PERMISSIONS.USE)) {
    return res.json({ success: true, code: 'disabled', created: false, day: localParts(new Date()).day });
  }
  const result = await AttendanceService.checkIn(req.user!.tenantId, req.user!.id, {
    latitude: body.latitude, longitude: body.longitude, accuracy: body.accuracy, status: body.locationStatus,
  });
  res.json({ success: true, ...result });
}));

// Everything else needs the section on
attendanceRouter.use(checkSection('attendance') as any);

// GET /api/attendance/me?month=YYYY-MM - the signed-in user's own month
attendanceRouter.get('/me', handle(async (req, res) => {
  if (!allows(await roleAccess(req.user!.tenantId, req.user!.roleId), ATTENDANCE_PERMISSIONS.USE)) {
    return res.status(403).json({ error: 'Attendance is not used for your role', code: 'not_counted' });
  }
  const m = month.parse(req.query.month ?? localParts(new Date()).day.slice(0, 7));
  const data = await AttendanceService.month(req.user!.tenantId, m, req.user!.id);
  res.json({ success: true, data });
}));

// GET /api/attendance/day?date=YYYY-MM-DD - everyone on one day
attendanceRouter.get('/day', requirePermissions([ATTENDANCE_PERMISSIONS.READ]) as any, handle(async (req, res) => {
  const d = day.parse(req.query.date ?? localParts(new Date()).day);
  res.json({ success: true, data: await AttendanceService.day(req.user!.tenantId, d) });
}));

// GET /api/attendance/month?month=YYYY-MM - everyone's month with totals
attendanceRouter.get('/month', requirePermissions([ATTENDANCE_PERMISSIONS.READ]) as any, handle(async (req, res) => {
  const m = month.parse(req.query.month ?? localParts(new Date()).day.slice(0, 7));
  res.json({ success: true, data: await AttendanceService.month(req.user!.tenantId, m) });
}));

// PUT /api/attendance/records - correct a person's day (with a reason; audit-logged)
attendanceRouter.put('/records', requirePermissions([ATTENDANCE_PERMISSIONS.MANAGE]) as any, handle(async (req, res) => {
  const body = correctSchema.parse(req.body);
  res.json({ success: true, data: await AttendanceService.correct(req.user!.tenantId, req.user!.id, body, req.ip) });
}));

// POST /api/attendance/leave - leave over a date range
attendanceRouter.post('/leave', requirePermissions([ATTENDANCE_PERMISSIONS.MANAGE]) as any, handle(async (req, res) => {
  const body = leaveSchema.parse(req.body);
  res.json({ success: true, data: await AttendanceService.setLeave(req.user!.tenantId, req.user!.id, body) });
}));

// Holidays
attendanceRouter.get('/holidays', requirePermissions([ATTENDANCE_PERMISSIONS.READ]) as any, handle(async (req, res) => {
  const year = z.string().regex(/^\d{4}$/).parse(req.query.year ?? localParts(new Date()).day.slice(0, 4));
  res.json({ success: true, data: await AttendanceService.holidaysBetween(req.user!.tenantId, `${year}-01-01`, `${year}-12-31`) });
}));
attendanceRouter.post('/holidays', requirePermissions([ATTENDANCE_PERMISSIONS.MANAGE]) as any, handle(async (req, res) => {
  const body = holidaySchema.parse(req.body);
  res.json({ success: true, data: await AttendanceService.addHoliday(req.user!.tenantId, req.user!.id, body.day, body.name) });
}));
attendanceRouter.delete('/holidays/:day', requirePermissions([ATTENDANCE_PERMISSIONS.MANAGE]) as any, handle(async (req, res) => {
  await AttendanceService.removeHoliday(req.user!.tenantId, day.parse(req.params.day));
  res.json({ success: true });
}));

// Rules
attendanceRouter.get('/settings', requirePermissions([ATTENDANCE_PERMISSIONS.READ]) as any, handle(async (req, res) => {
  res.json({ success: true, data: await AttendanceService.getSettings(req.user!.tenantId) });
}));
attendanceRouter.put('/settings', requirePermissions([ATTENDANCE_PERMISSIONS.MANAGE]) as any, handle(async (req, res) => {
  const body = settingsSchema.parse(req.body);
  res.json({ success: true, data: await AttendanceService.updateSettings(req.user!.tenantId, req.user!.id, body) });
}));
