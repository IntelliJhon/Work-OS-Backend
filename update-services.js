const fs = require('fs');
const path = require('path');

function replaceAll(filePath, search, replace) {
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.split(search).join(replace);
    fs.writeFileSync(filePath, content, 'utf8');
}

function insertAfter(filePath, search, insertion) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(insertion)) return; // Idempotency
    content = content.replace(search, search + '\n' + insertion);
    fs.writeFileSync(filePath, content, 'utf8');
}

// 1. Gates
const gatesSvcPath = path.join(__dirname, 'src', 'modules', 'gates', 'gates.service.ts');
const gatesImport = `import { WorkflowInvariantService } from '../../services/workflow-invariant.service';`;
insertAfter(gatesSvcPath, "import { AuditService } from '../../services/audit.service';", gatesImport);

const approveGateGuard = `    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);`;
insertAfter(gatesSvcPath, "await PhasesService.unlockNextPhase(tx, tenantId, phase.projectId, phase.orderIndex);", approveGateGuard);

const resubmitGateCode = `
  static async resubmitGate(tx: any, tenantId: string, userId: string, ipAddress: string, gateId: string) {
    const gate = await GatesRepository.getGateById(tx, tenantId, gateId);
    if (!gate) throw new Error('Gate not found');
    if (gate.status !== 'rejected') throw new Error('Can only resubmit rejected gates');

    const updatedGate = await GatesRepository.updateGateStatus(tx, tenantId, gateId, 'resubmitted');
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, gate.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'quality_gates', recordId: gateId,
      oldValue: gate, newValue: updatedGate, ipAddress,
    });
    return updatedGate;
  }
`;
insertAfter(gatesSvcPath, "return updatedGate;\n  }", resubmitGateCode);

// 2. Phases
const phasesSvcPath = path.join(__dirname, 'src', 'modules', 'phases', 'phases.service.ts');
const phasesImport = `import { WorkflowInvariantService } from '../../services/workflow-invariant.service';`;
insertAfter(phasesSvcPath, "import { AuditService } from '../../services/audit.service';", phasesImport);

insertAfter(phasesSvcPath, "const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'active');", `    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);`);
insertAfter(phasesSvcPath, "const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'completed', true);", `    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);`);

const reopenPhaseCode = `
  static async reopenPhase(tx: any, tenantId: string, userId: string, ipAddress: string, phaseId: string) {
    const phase = await PhasesRepository.getPhaseById(tx, tenantId, phaseId);
    if (!phase) throw new Error('Phase not found');
    if (phase.status === 'active') throw new Error('Phase is already active');

    // Rule: no conflicting active phase exists
    const allPhases = await PhasesRepository.getPhasesByProjectId(tx, tenantId, phase.projectId);
    const activePhase = allPhases.find((p: any) => p.status === 'active');
    if (activePhase) throw new Error('Cannot reopen: Another phase is currently active');

    const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'active', false);
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'phases', recordId: phaseId,
      oldValue: phase, newValue: updatedPhase, ipAddress,
    });
    return updatedPhase;
  }
`;
insertAfter(phasesSvcPath, "const updatedPhase = await PhasesRepository.updatePhaseStatus(tx, tenantId, phaseId, 'blocked');", `    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, phase.projectId);`);
insertAfter(phasesSvcPath, "static async unlockNextPhase", reopenPhaseCode + "\n  static async unlockNextPhase");

// 3. Sprints
const sprintsSvcPath = path.join(__dirname, 'src', 'modules', 'sprints', 'sprints.service.ts');
const sprintsImport = `import { WorkflowInvariantService } from '../../services/workflow-invariant.service';`;
insertAfter(sprintsSvcPath, "import { AuditService } from '../../services/audit.service';", sprintsImport);

insertAfter(sprintsSvcPath, "const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'active');", `    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, sprint.projectId);`);
insertAfter(sprintsSvcPath, "const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'closed');", `    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, sprint.projectId);`);

const reopenSprintCode = `
  static async reopenSprint(tx: any, tenantId: string, userId: string, ipAddress: string, sprintId: string) {
    const sprint = await SprintsRepository.getSprintById(tx, tenantId, sprintId);
    if (!sprint) throw new Error('Sprint not found');
    if (sprint.status !== 'closed') throw new Error('Can only reopen closed sprints');

    const phase = await SprintsRepository.getPhaseById(tx, tenantId, sprint.phaseId);
    if (phase.status !== 'active') throw new Error('Cannot reopen sprint: parent phase is no longer active');

    const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'active');
    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, sprint.projectId);

    await AuditService.logAction({
      tenantId, userId, action: 'UPDATE', tableName: 'sprints', recordId: sprintId,
      oldValue: sprint, newValue: updatedSprint, ipAddress,
    });
    return updatedSprint;
  }
`;
insertAfter(sprintsSvcPath, "const updatedSprint = await SprintsRepository.updateSprintStatus(tx, tenantId, sprintId, 'cancelled');", `    await WorkflowInvariantService.validateWorkflowState(tx, tenantId, sprint.projectId);`);
insertAfter(sprintsSvcPath, "static async cancelSprint", reopenSprintCode + "\n  static async cancelSprint");

// Update controllers and routes
// Gates
const gatesCtrlPath = path.join(__dirname, 'src', 'modules', 'gates', 'gates.controller.ts');
const gatesCtrlInsert = `
  static async resubmit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const gateId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await GatesService.resubmitGate(tx, tenantId, req.user!.id, req.ip || '', gateId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
`;
insertAfter(gatesCtrlPath, "static async listByProject", gatesCtrlInsert + "\n  static async listByProject");

const gatesRoutePath = path.join(__dirname, 'src', 'modules', 'gates', 'gates.routes.ts');
insertAfter(gatesRoutePath, "gatesRouter.post('/:id/reject'", "gatesRouter.post('/:id/resubmit', requirePermissions(['project.manage']), GatesController.resubmit);");

// Phases
const phasesCtrlPath = path.join(__dirname, 'src', 'modules', 'phases', 'phases.controller.ts');
const phasesCtrlInsert = `
  static async reopen(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const phaseId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await PhasesService.reopenPhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
`;
insertAfter(phasesCtrlPath, "static async block", phasesCtrlInsert + "\n  static async block");

const phasesRoutePath = path.join(__dirname, 'src', 'modules', 'phases', 'phases.routes.ts');
insertAfter(phasesRoutePath, "phasesRouter.post('/:id/block'", "phasesRouter.post('/:id/reopen', requirePermissions(['project.manage']), PhasesController.reopen);");

// Sprints
const sprintsCtrlPath = path.join(__dirname, 'src', 'modules', 'sprints', 'sprints.controller.ts');
const sprintsCtrlInsert = `
  static async reopen(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.app.locals.tenantId;
      const sprintId = req.params.id as string;

      const result = await withTenant(tenantId, async (tx) => {
        return await SprintsService.reopenSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  }
`;
insertAfter(sprintsCtrlPath, "static async cancel", sprintsCtrlInsert + "\n  static async cancel");

const sprintsRoutePath = path.join(__dirname, 'src', 'modules', 'sprints', 'sprints.routes.ts');
insertAfter(sprintsRoutePath, "sprintsRouter.post('/:id/cancel'", "sprintsRouter.post('/:id/reopen', requirePermissions(['project.manage']), SprintsController.reopen);");

console.log("Services updated with recovery flows and invariant guards.");
