import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000'),
  DATABASE_URL: z.string().url(),
  DATABASE_URL_DIRECT: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(10),
  JWT_REFRESH_SECRET: z.string().min(10),
  JWT_ACCESS_EXPIRATION: z.string().default('15m'),
  JWT_REFRESH_EXPIRATION: z.string().default('7d'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  CLOUDINARY_URL: z.string().url().optional(),
  GLOBAL_RATE_LIMIT_MAX: z.string().default('5000').transform(val => parseInt(val, 10)),
  AUTH_RATE_LIMIT_MAX: z.string().default('500').transform(val => parseInt(val, 10)),
  N8N_OPEN_POINT_WEBHOOK: z.string().optional().default(''),
  APP_URL: z.string().optional().default('http://localhost:5173'),
  AUTOMATIONS_BUILDER_API_BASE: z.string().optional().default('https://partner-api.automationsbuilder.com'),
  AUTOMATIONS_BUILDER_API_TOKEN: z.string().optional().default('ed30d865-61a9-4d02-9af8-e262cd9962d4'),
  CRON_SECRET: z.string().optional().default('workos_expiry_cron_secret_2026'),
  EXPIRY_ALERT_TEST_NUMBER: z.string().optional().default('7736956474'),
  CRM_API_ACCESS_TOKEN: z.string().optional().default('nN4nTt9OSg5MkY1MksuWT3VmMfTkMIYhSghRJcAREFTSAoetUtHWYNrleHTUXzEmsREFTSAEqnPgpf6OQ75GYg4oM3rXFE0bORedVU5ERVJTQ09SRQY56ho939eYgJz1H88zR855ikVU5ERVJTQ09SRQ6sVeIIw'),
  CRM_PHONE_NUMBER_ID: z.string().optional().default('810611068796796'),
  CRM_API_URL: z.string().optional().default('https://crmapi.waau.in/api/meta'),

  // Voice notes (n8n -> Work OS). No default on purpose: if unset, the integration endpoint is disabled.
  VOICE_INTEGRATION_SECRET: z.string().min(32).optional(),
  // Meta "Authentication" category template used to send the phone verification code
  WHATSAPP_OTP_TEMPLATE: z.string().optional().default('workos_verify_code'),
  WHATSAPP_OTP_TEMPLATE_LANG: z.string().optional().default('en'),
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/).optional().default('91'),
  // Utility templates sent after a voice note becomes assigned work (see voice-assignment.service.ts for variables)
  WHATSAPP_WORK_OWNER_TEMPLATE: z.string().optional().default('work_os_work_assigned'),
  WHATSAPP_WORK_EMPLOYEE_TEMPLATE: z.string().optional().default('work_os_new_work'),
  WHATSAPP_WORK_TEMPLATE_LANG: z.string().optional().default('en'),
  // Sent to the assignee before the due time: {{1}} first name, {{2}} work id, {{3}} work, {{4}} due
  WHATSAPP_WORK_REMINDER_TEMPLATE: z.string().optional().default('work_os_work_reminder'),
  // Leave: to an approver {{1}} first name, {{2}} applicant, {{3}} dates, {{4}} reason;
  // to the applicant {{1}} first name, {{2}} dates, {{3}} what happened
  WHATSAPP_LEAVE_REQUEST_TEMPLATE: z.string().optional().default('work_os_leave_request'),
  WHATSAPP_LEAVE_UPDATE_TEMPLATE: z.string().optional().default('work_os_leave_update'),
  // Invitation (Utility template): {{1}} inviter, {{2}} workspace, {{3}} role; website button with a dynamic URL ending in the token
  WHATSAPP_INVITE_TEMPLATE: z.string().optional().default('work_os_account_setup'),
  // Bill/renewal reminder: {{1}} first name, {{2}} what, {{3}} due, {{4}} amount; website button with a dynamic
  // URL ending in the reminder id (…/reminders/{{1}})
  WHATSAPP_DUE_REMINDER_TEMPLATE: z.string().optional().default('work_os_due_reminder'),
  // To whoever assigned a task when it is done: {{1}} first name, {{2}} work id, {{3}} work, {{4}} done by
  WHATSAPP_WORK_DONE_TEMPLATE: z.string().optional().default('work_os_work_done'),
  // AI summaries of group chats (Google Gemini); without a key the Summary button says it is not set up
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional().default('gemini-2.5-flash'),
  // A request the manager hasn't decided after this many hours goes to the Admins
  LEAVE_ESCALATION_HOURS: z.coerce.number().min(1).max(720).optional().default(12),
  // Reminder for work from a voice note that has a due time (minutes before; 0 = none)
  VOICE_REMINDER_MINUTES: z.coerce.number().int().min(0).max(10080).optional().default(120),
  // Every session ends at this local time (WORK_TIMEZONE), so the next day starts with a login = attendance
  // check-in. '' = sessions last the usual 7 days.
  DAILY_LOGOUT_TIME: z.string().optional().default('00:00'),
  // 'false' stops this process from sending work reminders (e.g. a local server on the production database)
  TASK_REMINDERS_ENABLED: z.string().optional().default('true'),
  // How long a voice note waits for the owner to name the employee
  VOICE_ASSIGNEE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).optional().default(30),
  // Used to resolve spoken dates/times ("tomorrow at 5") and to format due dates in messages
  WORK_TIMEZONE: z.string().optional().default('Asia/Kolkata'),
  // 32-byte key (64 hex chars) for secrets stored in the database, e.g. workspaces' WhatsApp tokens
  SECRETS_ENCRYPTION_KEY: z.string().optional(),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
