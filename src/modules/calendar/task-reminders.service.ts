import { and, eq, gt, isNotNull, isNull, lte, min, notInArray } from 'drizzle-orm';
import { db } from '../../db';
import { tasks } from '../../db/schema/tasks';
import { tenants } from '../../db/schema/tenants';
import { users } from '../../db/schema/users';
import { withTenant } from '../../middleware/tenant.middleware';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppService } from '../../services/whatsapp.service';
import { WhatsAppBotsService } from '../whatsapp-bots/whatsapp-bots.service';
import { formatWorkId } from '../tasks/tasks.service';
import { formatDueLabel } from './task-schedule';
import { maskPhone } from '../../lib/phone';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { SectionsService } from '../sections/sections.service';
import { everyRound } from '../../jobs/background-clock';

/**
 * Sends each task's reminder once, at tasks.remind_at: a Work OS notification and a WhatsApp template
 * to the assignee. Checked in each background round, and a timer wakes the check at the next reminder's exact
 * time (BullMQ delayed jobs need Redis, which is off). A reminder is claimed (reminder_sent_at set) before it
 * is sent, so it is never sent twice.
 */

// Longest single timer (setTimeout tops out near 24.8 days); a later reminder is re-armed by a later round
const MAX_TIMER_MS = 20 * 86_400_000;
// A reminder more than this late (e.g. the server was down) is dropped rather than sent
const MAX_LATENESS_MS = 6 * 60 * 60_000;
const FINISHED_STATUSES = ['done', 'completed', 'cancelled'];

async function sendTenantReminders(tenantId: string, now: Date): Promise<number> {
  const claimed = await withTenant(tenantId, async (tx) => {
    const dueTasks = await tx
      .update(tasks)
      .set({ reminderSentAt: now })
      .where(and(
        eq(tasks.tenantId, tenantId),
        isNull(tasks.reminderSentAt),
        isNotNull(tasks.remindAt),
        lte(tasks.remindAt, now),
        gt(tasks.remindAt, new Date(now.getTime() - MAX_LATENESS_MS)),
        isNull(tasks.deletedAt),
        isNotNull(tasks.assigneeId),
        notInArray(tasks.status, FINISHED_STATUSES),
      ))
      .returning();

    const out: { task: typeof tasks.$inferSelect; firstName: string; phone: string | null; due: string; workId: string }[] = [];
    for (const task of dueTasks) {
      const [assignee] = await tx
        .select({ firstName: users.firstName, phone: users.phone })
        .from(users)
        .where(and(eq(users.id, task.assigneeId!), isNull(users.deletedAt)))
        .limit(1);
      if (!assignee) continue;

      const workId = formatWorkId(task.taskNumber) ?? task.id.slice(0, 8).toUpperCase();
      const due = formatDueLabel(task.customFields) ?? 'soon';
      await NotificationsService.notify({
        tenantId,
        recipientUserId: task.assigneeId!,
        type: 'task_reminder',
        title: `Reminder: ${workId} is due ${due}`,
        message: task.name,
        entityType: 'task',
        entityId: task.id,
        priority: 'warning',
        metadata: { workId, dueAt: task.dueAt },
      }, tx);
      out.push({ task, firstName: assignee.firstName, phone: assignee.phone, due, workId });
    }
    return out;
  });

  if (!claimed.length) return 0;
  const wa = await WhatsAppBotsService.forTenant(tenantId);
  for (const { task, firstName, phone, due, workId } of claimed) {
    if (!phone) continue;
    // {{1}} first name, {{2}} work id, {{3}} work, {{4}} due
    const sent = await WhatsAppService.sendBodyTemplate(phone, wa.templates.reminder, wa.templates.lang, [firstName, workId, task.name, due], wa.sender);
    if (!sent.success) {
      logger.warn({ taskId: task.id, to: maskPhone(phone), error: sent.error }, '[TaskReminders] WhatsApp reminder failed');
    }
  }
  logger.info({ tenantId, count: claimed.length }, '[TaskReminders] Reminders sent');
  return claimed.length;
}

/** The tenant's next unsent reminder moment */
async function nextTenantReminder(tenantId: string, now: Date): Promise<Date | null> {
  const [row] = await withTenant<{ at: Date | null }[]>(tenantId, (tx) => tx
    .select({ at: min(tasks.remindAt) })
    .from(tasks)
    .where(and(
      eq(tasks.tenantId, tenantId),
      isNull(tasks.reminderSentAt),
      gt(tasks.remindAt, now),
      isNull(tasks.deletedAt),
      isNotNull(tasks.assigneeId),
      notInArray(tasks.status, FINISHED_STATUSES),
    )));
  return row?.at ? new Date(row.at) : null;
}

export async function sendDueReminders(now: Date = new Date()): Promise<number> {
  const active = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.isActive, true), isNull(tenants.deletedAt)));

  let total = 0;
  for (const { id } of active) {
    try {
      if (!(await SectionsService.isEnabled(id, 'tasks'))) continue;
      total += await sendTenantReminders(id, now);
      wakeForReminder(await nextTenantReminder(id, now));
    } catch (err) {
      logger.error({ err, tenantId: id }, '[TaskReminders] Sending reminders failed for tenant');
    }
  }
  return total;
}

let enabled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let timerAt = Infinity;

async function check() {
  if (running) {
    // A round is already sending; look again shortly so this moment is not missed
    setTimeout(() => void check(), 30_000);
    return;
  }
  running = true;
  try {
    await sendDueReminders();
  } catch (err) {
    logger.error({ err }, '[TaskReminders] Reminder check failed');
  } finally {
    running = false;
  }
}

/** Makes sure the check runs at this reminder moment (called when a task's reminder is set, and after each check) */
export function wakeForReminder(at: Date | null | undefined) {
  if (!enabled || !at) return;
  const t = at.getTime();
  if (t >= timerAt) return;
  const wait = t - Date.now() + 1_000;
  if (wait > MAX_TIMER_MS) return;
  if (timer) clearTimeout(timer);
  timerAt = t;
  timer = setTimeout(() => {
    timer = null;
    timerAt = Infinity;
    void check();
  }, Math.max(wait, 1_000));
}

export function startTaskReminders() {
  if (env.TASK_REMINDERS_ENABLED === 'false') {
    logger.info('[TaskReminders] Disabled (TASK_REMINDERS_ENABLED=false)');
    return;
  }
  enabled = true;
  everyRound('task reminders', check);
  logger.info('[TaskReminders] Reminders go out at their set time');
}
