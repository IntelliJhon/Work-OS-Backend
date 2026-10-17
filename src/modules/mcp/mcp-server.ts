import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../../config/logger';
import { McpKeysService, MCP_SECTIONS, type McpContext, type McpSection } from './mcp-keys.service';
import * as data from './mcp-data';

/**
 * The Work OS MCP server (Model Context Protocol), for n8n's MCP Client, Claude, ChatGPT and other AI tools.
 * POST /mcp with "Authorization: Bearer wos_mcp_…". Stateless: each request gets its own server, bound to the
 * key's workspace and sections. Every tool is read-only.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date like 2026-10-17');
const limit = z.number().int().min(1).max(data.MAX_ROWS).optional().describe(`How many rows at most (default 100, max ${data.MAX_ROWS})`);
const person = z.string().min(1).describe('A person\'s name or email (part of the name works)');

type Shape = Record<string, z.ZodTypeAny>;
interface ToolDef { section: McpSection | null; title: string; description: string; input: Shape; run: (ctx: McpContext, args: any) => Promise<unknown> }

const TOOLS: Record<string, ToolDef> = {
  workspace_overview: {
    section: null, title: 'Workspace overview',
    description: 'Today at a glance for the whole workspace: members, task counts by status, overdue work, today\'s attendance, leave waiting for approval, reminders due, clients. Start here.',
    input: {},
    run: (ctx) => data.workspaceOverview(ctx.tenantId, ctx.sections),
  },
  list_people: {
    section: null, title: 'People',
    description: 'Everyone in the workspace with their role, email and who they report to.',
    input: { includeRemoved: z.boolean().optional().describe('Also list people who were removed') },
    run: (ctx, a) => data.listPeople(ctx.tenantId, !!a.includeRemoved),
  },
  list_projects: {
    section: 'projects', title: 'Projects',
    description: 'Projects with their client ("Company Projects" for internal work), status, project manager and open/done task counts.',
    input: { status: z.enum(['active', 'completed', 'archived']).optional(), client: z.string().optional().describe('Client name (part works)'), search: z.string().optional(), limit },
    run: (ctx, a) => data.listProjects(ctx.tenantId, a),
  },
  list_tasks: {
    section: 'tasks', title: 'Tasks (work items)',
    description: 'Work items (W-numbers) with status, assignee, who assigned it, project, due date and completion. Filter by person, status, project, overdue, due dates, completion dates or words. Statuses: todo, in_progress, in_review, blocked, done.',
    input: {
      person: person.optional(), status: z.string().optional(), project: z.string().optional().describe('Project name (part works)'),
      overdue: z.boolean().optional().describe('Only work past its due time and not done'),
      dueFrom: day.optional(), dueTo: day.optional(), completedFrom: day.optional(), completedTo: day.optional(),
      search: z.string().optional().describe('Words in the name or description'), limit,
    },
    run: (ctx, a) => data.listTasks(ctx.tenantId, a),
  },
  get_task: {
    section: 'tasks', title: 'One work item',
    description: 'Full details of one work item by its number (e.g. "W-96" or 96): description, subtasks and the time logged on it.',
    input: { workId: z.union([z.string(), z.number()]).describe('e.g. "W-96"') },
    run: (ctx, a) => data.getTask(ctx.tenantId, String(a.workId)),
  },
  attendance_day: {
    section: 'attendance', title: 'Attendance for a day',
    description: 'Each person\'s attendance on one day: present, late, absent, leave, day off or holiday, with check-in time and place.',
    input: { date: day.optional().describe('Default: today') },
    run: (ctx, a) => data.attendanceDay(ctx.tenantId, a.date),
  },
  attendance_month: {
    section: 'attendance', title: 'Attendance for a month',
    description: 'Monthly totals per person (present, early, late, absent, leave). Give a person to also get their day-by-day list.',
    input: { month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('e.g. 2026-10 (default: this month)'), person: person.optional() },
    run: (ctx, a) => data.attendanceMonth(ctx.tenantId, a.month, a.person),
  },
  list_leave: {
    section: 'leave', title: 'Leave',
    description: 'Leave requests with dates, days, reason, status (pending_manager, pending_admin, approved, rejected, cancelled) and who decided.',
    input: { status: z.enum(['pending_manager', 'pending_admin', 'approved', 'rejected', 'cancelled']).optional(), person: person.optional(), from: day.optional(), to: day.optional(), limit },
    run: (ctx, a) => data.listLeave(ctx.tenantId, a),
  },
  hours_worked: {
    section: 'hours', title: 'Hours worked',
    description: 'Time logged on project work per person per day (a full day is 8 hours; working days under 8 hours are flagged). Up to two months. Set withEntries for what was done.',
    input: { from: day.optional().describe('Default: 6 days before "to"'), to: day.optional().describe('Default: today'), person: person.optional(), withEntries: z.boolean().optional() },
    run: (ctx, a) => data.hoursWorked(ctx.tenantId, a),
  },
  list_work_reports: {
    section: 'hours', title: 'Work reports',
    description: 'One person\'s work reports (including the ones made from time logs), newest first.',
    input: { person, from: day.optional(), to: day.optional(), limit },
    run: (ctx, a) => data.listWorkReports(ctx.tenantId, a),
  },
  list_clients: {
    section: 'clients', title: 'Clients',
    description: 'Clients with contact person, phone, email, city, category, account manager and status (active, on_hold, former).',
    input: { status: z.enum(['active', 'on_hold', 'former']).optional(), search: z.string().optional(), limit },
    run: (ctx, a) => data.listClients(ctx.tenantId, a),
  },
  get_client: {
    section: 'clients', title: 'One client',
    description: 'Everything about one client: details, their projects and recent notes.',
    input: { name: z.string().min(1) },
    run: (ctx, a) => data.getClient(ctx.tenantId, a.name),
  },
  list_reminders: {
    section: 'reminders', title: 'Reminders (bills and renewals)',
    description: 'Bills, renewals, subscriptions and taxes with amount (rupees), due date, owner and whether overdue. Default: active ones.',
    input: { status: z.enum(['active', 'done', 'cancelled']).optional(), dueBefore: day.optional(), limit },
    run: (ctx, a) => data.listReminders(ctx.tenantId, a),
  },
  list_groups: {
    section: 'groups', title: 'Group chats',
    description: 'The workspace\'s group chats with member counts and last activity.',
    input: {},
    run: (ctx) => data.listGroups(ctx.tenantId),
  },
  group_messages: {
    section: 'groups', title: 'Group chat messages',
    description: 'Messages in one group chat (oldest first), optionally for one day.',
    input: { group: z.string().min(1).describe('Group name (part works)'), date: day.optional(), limit },
    run: (ctx, a) => data.groupMessages(ctx.tenantId, a),
  },
};

function buildServer(ctx: McpContext) {
  const server = new McpServer(
    { name: 'work-os', version: '1.0.0' },
    {
      instructions: `Read-only access to the "${ctx.keyName}" key's Work OS workspace. Dates are India time (YYYY-MM-DD). `
        + `Start with workspace_overview. This key may read: people${[...ctx.sections].map((s) => `, ${MCP_SECTIONS[s].toLowerCase()}`).join('')}.`,
    },
  );
  for (const [name, def] of Object.entries(TOOLS)) {
    if (def.section && !ctx.sections.has(def.section)) continue;
    server.registerTool(name, {
      title: def.title,
      description: def.description,
      inputSchema: def.input as any,
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, (async (args: unknown) => {
      const started = Date.now();
      try {
        const result = await def.run(ctx, args ?? {});
        logger.info({ keyId: ctx.keyId, tenantId: ctx.tenantId, tool: name, ms: Date.now() - started }, '[MCP] Tool used');
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof data.McpInputError) return { content: [{ type: 'text', text: err.message }], isError: true };
        logger.error({ err, keyId: ctx.keyId, tool: name }, '[MCP] Tool failed');
        return { content: [{ type: 'text', text: 'Work OS could not answer this right now. Please try again.' }], isError: true };
      }
    }) as any);
  }
  return server;
}

export const mcpRouter = Router();

const bearer = (req: Request) => {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const x = req.headers['x-api-key'];
  return typeof x === 'string' ? x.trim() : undefined;
};

mcpRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = await McpKeysService.authenticate(bearer(req));
    if (!ctx) {
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked Work OS MCP key' }, id: null });
    }
    const server = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);
  } catch (err) {
    if (!res.headersSent) return next(err);
    logger.error({ err }, '[MCP] Request failed');
  }
});

// Stateless server: no event stream or session to resume or end
const notAllowed = (_req: Request, res: Response) =>
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST' }, id: null });
mcpRouter.get('/', notAllowed);
mcpRouter.delete('/', notAllowed);

export const TOOL_LIST = Object.entries(TOOLS).map(([name, t]) => ({ name, section: t.section, title: t.title }));
