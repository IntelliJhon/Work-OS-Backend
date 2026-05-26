import { ActivitiesRepository } from './activities.repository';
import { AuditService } from '../../services/audit.service';
import { NotFoundError } from '../../errors/workflow.errors';

export class ActivitiesService {
  static async createActivity(tx: any, tenantId: string, userId: string, ipAddress: string, data: any) {
    const activity = await ActivitiesRepository.createActivity(tx, tenantId, data);
    
    await AuditService.logAction({
      tenantId, userId, action: 'INSERT', tableName: 'activities', recordId: activity.id,
      newValue: activity, ipAddress,
    }, tx);
    
    return activity;
  }

  static async getActivities(tx: any, tenantId: string, projectId: string) {
    return await ActivitiesRepository.getActivitiesByProjectId(tx, tenantId, projectId);
  }

  static async deleteActivity(tx: any, tenantId: string, userId: string, ipAddress: string, activityId: string) {
    const oldActivity = await ActivitiesRepository.getActivityById(tx, tenantId, activityId);
    if (!oldActivity) throw new NotFoundError('Activity not found');

    const deleted = await ActivitiesRepository.deleteActivity(tx, tenantId, activityId);

    await AuditService.logAction({
      tenantId, userId, action: 'DELETE', tableName: 'activities', recordId: activityId,
      oldValue: oldActivity, ipAddress,
    }, tx);

    return deleted;
  }
}
