import { ProjectActivitiesRepository } from './project-activities.repository';

export class ProjectActivitiesService {
  static async create(tx: any, tenantId: string, data: { projectId: string; parentId?: string | null; title: string; workHrs: number }) {
    return await ProjectActivitiesRepository.create(tx, tenantId, data);
  }

  static async listByProject(tx: any, tenantId: string, projectId: string) {
    return await ProjectActivitiesRepository.listByProject(tx, tenantId, projectId);
  }

  static async update(tx: any, tenantId: string, id: string, data: { title?: string; workHrs?: number }) {
    return await ProjectActivitiesRepository.update(tx, tenantId, id, data);
  }

  static async delete(tx: any, tenantId: string, id: string) {
    return await ProjectActivitiesRepository.delete(tx, tenantId, id);
  }
}
