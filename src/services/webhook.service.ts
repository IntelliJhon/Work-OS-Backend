import { db } from '../db';
import { projects } from '../db/schema/projects';
import { users } from '../db/schema/users';
import { eq, and } from 'drizzle-orm';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { withTenant } from '../middleware/tenant.middleware';

export interface OpenPointWebhookPayload {
  id: string;
  projectId: string | null;
  projectName: string | null;
  parentTaskId: string;
  parentTask: string;
  title: string;
  description: string | null;
  priority: string;
  assignedToId: string | null;
  assignedToName: string | null;
  createdById: string;
  createdByName: string;
  status: string;
  createdAt: string;
  workspaceId: string;
  tenantId: string;
  url: string;
}

export class WebhookService {
  /**
   * Generic helper to post webhooks asynchronously in the background.
   * Reusable across all modules (Tasks, OPL, Activities, Leave Requests, HR Alerts, Onboarding).
   */
  static async postWebhook(url: string | undefined, payload: any, eventName: string): Promise<boolean> {
    if (!url || !url.trim()) {
      logger.debug({ eventName }, `No webhook URL configured for ${eventName}, skipping dispatch.`);
      return false;
    }

    try {
      logger.info('Dispatching notification webhook...');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WorkOS-Webhook-Service/1.0',
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();

      if (response.ok) {
        logger.info('Webhook sent successfully.');
        return true;
      }

      if (response.status === 500 && responseText.includes('No Respond to Webhook node')) {
        logger.info('Webhook sent successfully (n8n received payload).');
        return true;
      }

      throw new Error(`HTTP ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`);
    } catch (error: any) {
      logger.error(`Webhook notification failed:\n${error?.stack || error?.message || error}`);
      return false;
    }
  }

  /**
   * Sends an Open Point notification payload to the configured n8n webhook URL.
   */
  static async sendOpenPointNotification(data: OpenPointWebhookPayload): Promise<boolean> {
    const webhookUrl = env.N8N_OPEN_POINT_WEBHOOK;
    return await this.postWebhook(webhookUrl, data, 'Open Point');
  }

  /**
   * Inspects task creation/updates for newly added subtasks (Open Points)
   * and triggers the Open Point webhook notification for each new subtask.
   */
  static async processTaskSubtaskWebhooks(options: {
    tenantId: string;
    user: any;
    oldTask?: any;
    newTask: any;
  }): Promise<void> {
    const { tenantId, user, oldTask, newTask } = options;

    if (!newTask) return;

    const oldSubtasks: any[] = oldTask?.customFields?.subtasks || [];
    const newSubtasks: any[] = newTask?.customFields?.subtasks || [];

    if (!Array.isArray(newSubtasks) || newSubtasks.length === 0) {
      return;
    }

    const oldIds = new Set(oldSubtasks.map((s: any) => s?.id).filter(Boolean));
    const createdSubtasks = newSubtasks.filter((s: any) => s && s.id && !oldIds.has(s.id));

    if (createdSubtasks.length === 0) {
      return;
    }

    // Resolve project name if available (using withTenant to set RLS session context)
    let projectName: string | null = null;
    if (newTask.projectId) {
      try {
        await withTenant(tenantId, async (tx) => {
          const [proj] = await tx
            .select({ name: projects.name })
            .from(projects)
            .where(and(eq(projects.id, newTask.projectId), eq(projects.tenantId, tenantId)));
          if (proj) {
            projectName = proj.name;
          }
        });
      } catch (err) {
        logger.warn({ err, projectId: newTask.projectId }, 'Failed to fetch project name for webhook payload');
      }
    }

    const createdByName = user
      ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || 'System'
      : 'System';

    const baseUrl = env.APP_URL || 'http://localhost:5173';
    const frontendUrl = newTask.projectId
      ? `${baseUrl}/projects/${newTask.projectId}/opl`
      : `${baseUrl}/projects`;

    for (const subtask of createdSubtasks) {
      logger.info('Open Point created successfully.');

      // Resolve assignee name if assigneeId is set but assignee name is missing
      let assignedToName: string | null = subtask.assignee || null;
      if (!assignedToName && subtask.assigneeId) {
        try {
          await withTenant(tenantId, async (tx) => {
            const [assignedUser] = await tx
              .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
              .from(users)
              .where(eq(users.id, subtask.assigneeId));
            if (assignedUser) {
              assignedToName = `${assignedUser.firstName || ''} ${assignedUser.lastName || ''}`.trim() || assignedUser.email;
            }
          });
        } catch (err) {
          // ignore lookup error
        }
      }

      const payload: OpenPointWebhookPayload = {
        id: String(subtask.id),
        projectId: newTask.projectId ? String(newTask.projectId) : null,
        projectName: projectName,
        parentTaskId: String(newTask.id),
        parentTask: String(newTask.name || ''),
        title: String(subtask.title || ''),
        description: subtask.remarks || subtask.description || null,
        priority: String(subtask.priority || 'medium'),
        assignedToId: subtask.assigneeId ? String(subtask.assigneeId) : null,
        assignedToName: assignedToName,
        createdById: String(user.id),
        createdByName: createdByName,
        status: String(subtask.status || (subtask.done ? 'done' : 'to_do')),
        createdAt: subtask.createdAt || new Date().toISOString(),
        workspaceId: String(tenantId),
        tenantId: String(tenantId),
        url: frontendUrl,
      };

      await this.sendOpenPointNotification(payload);
    }
  }
}
