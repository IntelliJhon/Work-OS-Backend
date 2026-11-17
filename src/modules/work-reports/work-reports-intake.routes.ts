import crypto from 'crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema/users';
import { tenants } from '../../db/schema/tenants';
import { workReports } from '../../db/schema/work_reports';
import { logger } from '../../config/logger';
import { WorkReportsController } from './work-reports.controller';

/**
 * /api/integrations/work-reports: machine-to-machine work reports (e.g. a daily report written by a scheduled task).
 *
 * Auth: X-Integration-Secret header = WORK_REPORT_INTEGRATION_SECRET (its own secret, at least 32 characters).
 * Only the accounts listed in WORK_REPORT_INTEGRATION_EMAILS (comma-separated) can be posted for.
 * If either variable is unset the endpoint is switched off (503).
 *
 * POST /check  { email, workDate, workspace? }                    -> { exists, reports: [{ id, title, createdAt }] }
 * POST /       { email, workDate, title, reportText, workspace? } -> { reportId, created }
 *   One automated report per person per work date: posting again for the same date returns the existing one.
 */
export const workReportsIntakeRouter = Router();

const SECRET = () => process.env.WORK_REPORT_INTEGRATION_SECRET || '';
const ALLOWED = () =>
  (process.env.WORK_REPORT_INTEGRATION_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const secretMatches = (provided: unknown, expected: string) => {
  if (typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

const requireSecret = (req: Request, res: Response, next: NextFunction) => {
  if (SECRET().length < 32 || ALLOWED().length === 0) {
    return res.status(503).json({ error: 'Integration disabled', code: 'not_configured' });
  }
  if (!secretMatches(req.headers['x-integration-secret'], SECRET())) {
    logger.warn({ ip: req.ip }, '[WorkReportIntake] Rejected request with invalid secret');
    return res.status(401).json({ error: 'Unauthorized', code: 'invalid_secret' });
  }
  return next();
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'workDate must be YYYY-MM-DD');
const base = z.object({
  email: z.string().email().max(255),
  workDate: day,
  workspace: z.string().min(1).max(255).optional(),
});
const createSchema = base.extend({
  title: z.string().min(1).max(255),
  reportText: z.string().min(1).max(50000),
});

class IntakeError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** The allowed, active account for this email (in the given workspace when the email is in several). */
async function findMember(email: string, workspace?: string) {
  const lower = email.trim().toLowerCase();
  if (!ALLOWED().includes(lower)) throw new IntakeError(403, 'email_not_allowed', 'This account is not enabled for automated reports');

  const rows = await db
    .select({
      id: users.id,
      tenantId: users.tenantId,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      tenantSlug: tenants.slug,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(
      and(
        sql`lower(${users.email}) = ${lower}`,
        isNull(users.deletedAt),
        eq(tenants.isActive, true),
        isNull(tenants.deletedAt),
        workspace ? or(eq(tenants.slug, workspace), sql`${tenants.id}::text = ${workspace}`) : undefined,
      ),
    );

  if (rows.length === 0) throw new IntakeError(404, 'member_not_found', 'No active account with this email');
  if (rows.length > 1) {
    throw new IntakeError(409, 'workspace_required', `This email is in several workspaces; send workspace (one of: ${rows.map((r) => r.tenantSlug).join(', ')})`);
  }
  return rows[0];
}

/** Reports already saved for this person on this work date. */
async function existingFor(member: { id: string; tenantId: string }, workDate: string) {
  return db
    .select({ id: workReports.id, title: workReports.title, createdAt: workReports.createdAt })
    .from(workReports)
    .where(
      and(
        eq(workReports.tenantId, member.tenantId),
        eq(workReports.employeeId, member.id),
        eq(workReports.authorId, member.id),
        eq(workReports.workDate, workDate),
        isNull(workReports.taskId),
      ),
    );
}

const handle = (fn: (req: Request) => Promise<{ status: number; body: unknown }>) => async (req: Request, res: Response) => {
  try {
    const { status, body } = await fn(req);
    return res.status(status).json(body);
  } catch (err) {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid request', code: 'invalid_body', issues: err.issues });
    if (err instanceof IntakeError) return res.status(err.status).json({ error: err.message, code: err.code });
    logger.error({ err }, '[WorkReportIntake] Failed');
    return res.status(500).json({ error: 'Internal error', code: 'internal' });
  }
};

workReportsIntakeRouter.post(
  '/check',
  requireSecret,
  handle(async (req) => {
    const body = base.parse(req.body);
    const member = await findMember(body.email, body.workspace);
    const reports = await existingFor(member, body.workDate);
    return { status: 200, body: { exists: reports.length > 0, reports } };
  }),
);

workReportsIntakeRouter.post(
  '/',
  requireSecret,
  handle(async (req) => {
    const body = createSchema.parse(req.body);
    const member = await findMember(body.email, body.workspace);

    const [already] = await existingFor(member, body.workDate);
    if (already) return { status: 200, body: { reportId: already.id, created: false } };

    const authorName = `${member.firstName} ${member.lastName}`.trim() || member.email.split('@')[0];
    const reportText = body.reportText.trim();
    const [report] = await db
      .insert(workReports)
      .values({
        tenantId: member.tenantId,
        employeeId: member.id,
        authorId: member.id,
        authorName,
        authorEmail: member.email,
        title: body.title.trim(),
        reportText,
        workDate: body.workDate,
      })
      .returning({ id: workReports.id });

    await WorkReportsController.syncClientRemarks(member.tenantId, report.id, reportText, authorName, new Date());
    logger.info({ reportId: report.id, workDate: body.workDate }, '[WorkReportIntake] Report saved');
    return { status: 201, body: { reportId: report.id, created: true } };
  }),
);
