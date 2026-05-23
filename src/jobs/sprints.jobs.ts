import { Queue, Job } from 'bullmq';
import { redisConnection } from './queues';
import { SprintsRepository } from '../modules/sprints/sprints.repository';
import { db } from '../db';
import { sprints } from '../db/schema/sprints';
import { withTenant } from '../middleware/tenant.middleware';

/**
 * Clean Architecture Skeleton for Sprint Planning Automation.
 * Prepared for future automated rollover, automated next sprint planning,
 * and recurring cadence execution.
 */

// 1. Initialize BullMQ sprints queue
export const sprintsQueue = new Queue('sprintsQueue', { connection: redisConnection });

// 2. Define job types and payloads for sprints automation
export type SprintsJobType = 'AUTO_CREATE_NEXT' | 'ROLLOVER_INCOMPLETE_TASKS' | 'WEEKLY_CADENCE_CHECK';

export interface AutoCreateNextSprintPayload {
  tenantId: string;
  projectId: string;
  phaseId: string;
  previousSprintId: string;
  previousSprintName: string;
  previousEndDate: string; // ISO string
  cadenceType: 'WEEK' | 'MONTH' | 'CUSTOM';
  cadenceInterval: number;
}

export interface SprintRolloverPayload {
  tenantId: string;
  sprintId: string;
  targetSprintId: string;
}

/**
 * Core processor mapping outline.
 * This class prepares clean modular interfaces that future BullMQ workers can invoke
 * to perform the actual calculations and database mutations.
 */
export class SprintsJobProcessor {
  /**
   * Future-proof logic to auto-create the next sprint increment.
   * Calculates correct dates dynamically based on stored cadenceType & cadenceInterval.
   */
  static async autoCreateNextSprint(payload: AutoCreateNextSprintPayload): Promise<any> {
    const { 
      tenantId, 
      projectId, 
      phaseId, 
      previousSprintName, 
      previousEndDate, 
      cadenceType, 
      cadenceInterval 
    } = payload;

    // 1. Calculate new start and end dates
    const startDate = new Date(previousEndDate);
    const endDate = new Date(startDate);

    if (cadenceType === 'WEEK') {
      endDate.setDate(startDate.getDate() + (7 * cadenceInterval));
    } else if (cadenceType === 'MONTH') {
      endDate.setMonth(startDate.getMonth() + cadenceInterval);
    } else {
      // Custom - default to 2 weeks if custom and no dates supplied
      endDate.setDate(startDate.getDate() + 14);
    }

    // 2. Auto-generate the next sprint name dynamically
    // E.g. "Sprint 1 Setup" -> "Sprint 2 Setup", or "Increment 3" -> "Increment 4"
    let nextName = `${previousSprintName} Next`;
    const numMatch = previousSprintName.match(/(Sprint|Increment)\s*(\d+)/i);
    if (numMatch) {
      const type = numMatch[1];
      const nextNum = parseInt(numMatch[2], 10) + 1;
      nextName = previousSprintName.replace(numMatch[0], `${type} ${nextNum}`);
    }

    console.log(`[BullMQ Future Preparation] Planning auto-created sprint: "${nextName}" for Project: ${projectId}`);

    // Inside transaction
    return await withTenant(tenantId, async (tx) => {
      // Persist next sprint inside database automatically
      const nextSprintData = {
        projectId,
        phaseId,
        name: nextName,
        startDate,
        endDate,
        status: 'planning', // Provision next sprint in planning state
        cadenceType,
        cadenceInterval,
      };

      // In the future: return await SprintsRepository.createSprint(tx, tenantId, nextSprintData);
      return nextSprintData;
    });
  }

  /**
   * Future-proof logic to roll over incomplete tasks to a target sprint.
   */
  static async rolloverIncompleteTasks(payload: SprintRolloverPayload): Promise<void> {
    const { tenantId, sprintId, targetSprintId } = payload;
    
    console.log(`[BullMQ Future Preparation] Rolling over incomplete tasks from ${sprintId} to ${targetSprintId}`);
    
    await withTenant(tenantId, async (tx) => {
      // 1. Query incomplete tasks from the completed sprint
      const incompleteTasks = await SprintsRepository.getIncompleteTasksForSprint(tx, tenantId, sprintId);
      
      // 2. Loop and re-assign tasks.sprintId = targetSprintId
      for (const task of incompleteTasks) {
        // In the future:
        // await tx.update(tasks).set({ sprintId: targetSprintId }).where(eq(tasks.id, task.id));
      }
    });
  }
}
