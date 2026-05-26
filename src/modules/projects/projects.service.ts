import { ProjectsRepository } from './projects.repository';
import { CreateProjectInput, PhaseInput } from './projects.types';
import { AuditService } from '../../services/audit.service';
import { GatesRepository } from '../gates/gates.repository';
import { PhasesRepository } from '../phases/phases.repository';
import { sprints } from '../../db/schema/sprints';
import { activities } from '../../db/schema/activities';
import { phases } from '../../db/schema/phases';
import { projectMembers } from '../../db/schema/project_members';
import { projects } from '../../db/schema/projects';
import { tasks } from '../../db/schema/tasks';
import { and, eq } from 'drizzle-orm';


const DEFAULT_PHASES = [
  { name: 'Initiation', criteria: { 'Project charter uploaded': false } },
  { name: 'Planning', criteria: { 'Budget approved': false, 'Timeline approved': false, 'Risks logged': false } },
  { name: 'Design', criteria: { 'Architecture approved': false, 'UX approved': false } },
  { name: 'Build', criteria: { 'All sprint tasks completed': false, 'Code review passed': false } },
  { name: 'Testing', criteria: { 'Zero critical bugs': false, 'UAT signoff completed': false } },
  { name: 'Go Live', criteria: { 'Deployment completed': false, 'Retrospective completed': false } },
  { name: 'Stabilization', criteria: { 'Post-launch monitoring completed': false, 'Feedback loop established': false } },
];

export class ProjectsService {
  static async initializeProject(tx: any, tenantId: string, userId: string, ipAddress: string, input: CreateProjectInput) {
    // 1. Create the project
    const project = await ProjectsRepository.createProject(tx, tenantId, input);

    // 2. Generate default phases
    const phasesData: PhaseInput[] = DEFAULT_PHASES.map((phaseConfig, index) => {
      const orderIndex = index + 1;
      const isFirstPhase = orderIndex === 1;

      return {
        tenantId,
        projectId: project.id,
        name: phaseConfig.name,
        orderIndex,
        status: isFirstPhase ? 'active' : 'pending',
        isLocked: !isFirstPhase,
      };
    });

    // 3. Create the phases in bulk
    const phases = await ProjectsRepository.createPhasesBulk(tx, phasesData);

    // 3.5 Generate quality gates linked to created phases
    const gatesData = phases.map((phase: any, index: number) => {
      return {
        tenantId,
        projectId: project.id,
        phaseId: phase.id,
        criteria: DEFAULT_PHASES[index].criteria,
        status: 'pending',
      };
    });

    const gates = await GatesRepository.createGatesBulk(tx, gatesData);

    // 4. Log audit entries
    await AuditService.logAction({
      tenantId,
      userId,
      action: 'INSERT',
      tableName: 'projects',
      recordId: project.id,
      newValue: project,
      ipAddress,
    }, tx);

    // Log the phases creation
    for (const phase of phases) {
      await AuditService.logAction({
        tenantId,
        userId,
        action: 'INSERT',
        tableName: 'phases',
        recordId: phase.id,
        newValue: phase,
        ipAddress,
      }, tx);
    }

    return { project, phases };
  }

  static async getProjects(tx: any, tenantId: string, userId: string, permissions: Record<string, boolean>) {
    if (permissions['admin'] === true || permissions['project.manage'] === true) {
      return await ProjectsRepository.findProjectsByTenant(tx, tenantId);
    }

    // 1. Projects where user is a direct member
    const memberProjects = await tx
      .select({
        id: projects.id,
        pmId: projects.pmId,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .innerJoin(projectMembers, eq(projects.id, projectMembers.projectId))
      .where(
        and(
          eq(projects.tenantId, tenantId),
          eq(projectMembers.userId, userId)
        )
      );

    // 2. Projects where user is an assignee of any task in the project
    const assignedProjects = await tx
      .select({
        id: projects.id,
        pmId: projects.pmId,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .innerJoin(tasks, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(projects.tenantId, tenantId),
          eq(tasks.assigneeId, userId)
        )
      );

    // 3. De-duplicate and merge
    const seen = new Set<string>();
    const merged: typeof memberProjects = [];

    for (const p of [...memberProjects, ...assignedProjects]) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        merged.push(p);
      }
    }

    // 4. Attach phases to each project so the frontend can compute real progress
    if (merged.length === 0) return merged;
    const phasesList = await tx.select().from(phases).where(eq(phases.tenantId, tenantId));
    const activitiesList = await tx.select().from(activities).where(eq(activities.tenantId, tenantId));
    return merged.map((project: any) => {
      const projPhases = phasesList.filter((p: any) => p.projectId === project.id);
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
        sprints: activitiesList.filter((s: any) => s.projectId === project.id),
      };
    });
  }

  static async getProjectDetail(tx: any, tenantId: string, projectId: string) {
    const project = await ProjectsRepository.findProjectById(tx, tenantId, projectId);
    if (!project) return null;

    const phasesList = await PhasesRepository.getPhasesByProjectId(tx, tenantId, projectId);
    const gatesList = await GatesRepository.getGatesByProjectId(tx, tenantId, projectId);
    const activitiesList = await tx.select().from(activities).where(and(eq(activities.projectId, projectId), eq(activities.tenantId, tenantId)));
    const sprintsList = await tx.select().from(sprints).where(and(eq(sprints.projectId, projectId), eq(sprints.tenantId, tenantId)));

    const mappedSprints = sprintsList.map((sprint: any) => {
      const parentActivity = activitiesList.find((a: any) => a.id === sprint.activityId);
      return {
        ...sprint,
        phaseId: parentActivity ? parentActivity.phaseId : null,
      };
    });

    const allCompleted = phasesList.length > 0 && phasesList.every((p: any) => p.status === 'completed');
    let status = project.status;
    
    if (status === 'completed' && !allCompleted) {
      status = 'active';
      await tx.update(projects)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    } else if (status === 'active' && allCompleted) {
      status = 'completed';
      await tx.update(projects)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    }

    return {
      ...project,
      status,
      phases: phasesList,
      gates: gatesList,
      activities: activitiesList,
      sprints: mappedSprints,
    };
  }

  static async updateProject(tx: any, tenantId: string, userId: string, ipAddress: string, projectId: string, data: Partial<CreateProjectInput>) {
    const oldProject = await ProjectsRepository.findProjectById(tx, tenantId, projectId);
    if (!oldProject) throw new Error('Project not found');

    const updatedProject = await ProjectsRepository.updateProject(tx, tenantId, projectId, data);

    await AuditService.logAction({
      tenantId,
      userId,
      action: 'UPDATE',
      tableName: 'projects',
      recordId: updatedProject.id,
      oldValue: oldProject,
      newValue: updatedProject,
      ipAddress,
    }, tx);

    return updatedProject;
  }

  static async deleteProject(tx: any, tenantId: string, userId: string, ipAddress: string, projectId: string) {
    const oldProject = await ProjectsRepository.findProjectById(tx, tenantId, projectId);
    if (!oldProject) throw new Error('Project not found');

    await ProjectsRepository.deleteProject(tx, tenantId, projectId);

    await AuditService.logAction({
      tenantId,
      userId,
      action: 'DELETE',
      tableName: 'projects',
      recordId: projectId,
      oldValue: oldProject,
      ipAddress,
    }, tx);
  }
}
