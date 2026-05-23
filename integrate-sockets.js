const fs = require('fs');
const path = require('path');

function insertAfter(filePath, search, insertion) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(insertion)) return; // Idempotency
    content = content.replace(search, search + '\n' + insertion);
    fs.writeFileSync(filePath, content, 'utf8');
}

function addImport(filePath, importLine) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes(importLine)) {
        // Insert after first line
        const lines = content.split('\n');
        lines.splice(1, 0, importLine);
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    }
}

const socketImport = `import { emitWorkflowEvent } from '../../socket/eventEmitter';`;

// 1. Phases
const phasesCtrl = path.join(__dirname, 'src', 'modules', 'phases', 'phases.controller.ts');
addImport(phasesCtrl, socketImport);

function buildEmit(type, entityType, idVar) {
  return `      emitWorkflowEvent({
        type: '${type}',
        tenantId,
        actorId: req.user!.id,
        timestamp: new Date().toISOString(),
        entityType: '${entityType}',
        entityId: ${idVar},
        payload: result
      });`;
}

insertAfter(phasesCtrl, 
  "return await PhasesService.activatePhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);\n      });", 
  buildEmit('PHASE_ACTIVATED', 'phase', 'phaseId')
);

insertAfter(phasesCtrl, 
  "return await PhasesService.completePhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);\n      });", 
  buildEmit('PHASE_COMPLETED', 'phase', 'phaseId')
);

insertAfter(phasesCtrl, 
  "return await PhasesService.reopenPhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);\n      });", 
  buildEmit('PHASE_REOPENED', 'phase', 'phaseId')
);

insertAfter(phasesCtrl, 
  "return await PhasesService.blockPhase(tx, tenantId, req.user!.id, req.ip || '', phaseId);\n      });", 
  buildEmit('PHASE_BLOCKED', 'phase', 'phaseId')
);

// 2. Sprints
const sprintsCtrl = path.join(__dirname, 'src', 'modules', 'sprints', 'sprints.controller.ts');
addImport(sprintsCtrl, socketImport);

insertAfter(sprintsCtrl, 
  "return await SprintsService.startSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);\n      });", 
  buildEmit('SPRINT_STARTED', 'sprint', 'sprintId')
);

insertAfter(sprintsCtrl, 
  "return await SprintsService.closeSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);\n      });", 
  buildEmit('SPRINT_CLOSED', 'sprint', 'sprintId')
);

insertAfter(sprintsCtrl, 
  "return await SprintsService.reopenSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);\n      });", 
  buildEmit('SPRINT_REOPENED', 'sprint', 'sprintId')
);

insertAfter(sprintsCtrl, 
  "return await SprintsService.cancelSprint(tx, tenantId, req.user!.id, req.ip || '', sprintId);\n      });", 
  buildEmit('SPRINT_CANCELLED', 'sprint', 'sprintId')
);

// 3. Gates
const gatesCtrl = path.join(__dirname, 'src', 'modules', 'gates', 'gates.controller.ts');
addImport(gatesCtrl, socketImport);

insertAfter(gatesCtrl, 
  "return await GatesService.approveGate(tx, tenantId, req.user!.id, req.ip || '', gateId);\n      });", 
  buildEmit('GATE_APPROVED', 'gate', 'gateId')
);

insertAfter(gatesCtrl, 
  "return await GatesService.rejectGate(tx, tenantId, req.user!.id, req.ip || '', gateId);\n      });", 
  buildEmit('GATE_REJECTED', 'gate', 'gateId')
);

insertAfter(gatesCtrl, 
  "return await GatesService.resubmitGate(tx, tenantId, req.user!.id, req.ip || '', gateId);\n      });", 
  buildEmit('GATE_RESUBMITTED', 'gate', 'gateId')
);

console.log("Socket integrations successfully injected.");
