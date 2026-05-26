import { projects } from '../../db/schema/projects';
import { phases } from '../../db/schema/phases';
import { activities } from '../../db/schema/activities';
import { sprints } from '../../db/schema/sprints';
import { CreateProjectInput, PhaseInput } from './projects.types';
import { eq, and } from 'drizzle-orm';

export class ProjectsRepository {
  static async createProject(tx: any, tenantId: string, data: CreateProjectInput) {
    const [project] = await tx.insert(projects).values({
      tenantId,
      ...data,
    }).returning();
    return project;
  }

  static async createPhasesBulk(tx: any, phasesData: PhaseInput[]) {
    return await tx.insert(phases).values(phasesData).returning();
  }

  static async findProjectsByTenant(tx: any, tenantId: string) {
    const projectList = await tx.select().from(projects).where(eq(projects.tenantId, tenantId));
    const phasesList = await tx.select().from(phases).where(eq(phases.tenantId, tenantId));
    const activitiesList = await tx.select().from(activities).where(eq(activities.tenantId, tenantId));
    const sprintsList = await tx.select().from(sprints).where(eq(sprints.tenantId, tenantId));

    return projectList.map((project: any) => {
      const projPhases = phasesList.filter((p: any) => p.projectId === project.id);
      const projActivities = activitiesList.filter((a: any) => a.projectId === project.id);
      const projSprints = sprintsList.filter((s: any) => s.projectId === project.id);

      const mappedSprints = projSprints.map((sprint: any) => {
        const parentActivity = projActivities.find((a: any) => a.id === sprint.activityId);
        return {
          ...sprint,
          phaseId: parentActivity ? parentActivity.phaseId : null,
        };
      });

      const allCompleted = projPhases.length > 0 && projPhases.every((p: any) => p.status === 'completed');
      let status = project.status;
      
      if (status === 'completed' && !allCompleted) {
        status = 'active';
        tx.update(projects)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(projects.id, project.id))
          .execute().catch(() => {});
      } else if (status === 'active' && allCompleted) {
        status = 'completed';
        tx.update(projects)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(projects.id, project.id))
          .execute().catch(() => {});
      }

      return {
        ...project,
        status,
        phases: projPhases,
        activities: projActivities,
        sprints: mappedSprints,
      };
    });
  }

  static async findProjectById(tx: any, tenantId: string, projectId: string) {
    const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)));
    return project;
  }

  static async updateProject(tx: any, tenantId: string, projectId: string, data: Partial<CreateProjectInput>) {
    const [updatedProject] = await tx.update(projects)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)))
      .returning();
    return updatedProject;
  }

  static async deleteProject(tx: any, tenantId: string, projectId: string) {
    await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)));
  }
}
