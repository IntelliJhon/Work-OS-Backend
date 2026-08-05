import { ProjectActivitiesRepository } from './project-activities.repository';

export class ProjectActivitiesService {
  static async create(tx: any, tenantId: string, data: { projectId: string; title: string; workHrs: number }) {
    return await ProjectActivitiesRepository.create(tx, tenantId, data);
  }

  static async listByProject(tx: any, tenantId: string, projectId: string) {
    return await ProjectActivitiesRepository.listByProject(tx, tenantId, projectId);
  }

  static async delete(tx: any, tenantId: string, id: string) {
    return await ProjectActivitiesRepository.delete(tx, tenantId, id);
  }
}
