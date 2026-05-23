const fs = require('fs');
const path = require('path');

function insertNotificationHook(filePath, eventsMap, importLine) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Add import
    if (!content.includes('NotificationEvents')) {
        const lines = content.split('\n');
        lines.splice(1, 0, importLine);
        content = lines.join('\n');
    }

    // Insert hooks
    for (const [type, codeToInsert] of Object.entries(eventsMap)) {
        if (content.includes(codeToInsert)) continue; // idempotent
        const searchRegex = new RegExp(`emitWorkflowEvent\\(\\{\\s*type:\\s*'${type}'[\\s\\S]*?payload:\\s*result\\s*\\}\\);`, 'g');
        content = content.replace(searchRegex, (match) => {
            return match + '\n      ' + codeToInsert;
        });
    }

    fs.writeFileSync(filePath, content, 'utf8');
}

const importLine = `import { NotificationEvents } from '../notifications/notifications.events';`;

// 1. Phases
const phasesCtrl = path.join(__dirname, 'src', 'modules', 'phases', 'phases.controller.ts');
const phasesMap = {
    'PHASE_ACTIVATED': "await NotificationEvents.notifyPhaseEvent(tenantId, req.user!.id, result, 'PHASE_ACTIVATED', 'Phase Activated');",
    'PHASE_COMPLETED': "await NotificationEvents.notifyPhaseEvent(tenantId, req.user!.id, result, 'PHASE_COMPLETED', 'Phase Completed');",
    'PHASE_REOPENED': "await NotificationEvents.notifyPhaseEvent(tenantId, req.user!.id, result, 'PHASE_REOPENED', 'Phase Reopened');",
    'PHASE_BLOCKED': "await NotificationEvents.notifyPhaseEvent(tenantId, req.user!.id, result, 'PHASE_BLOCKED', 'Phase Blocked');"
};
insertNotificationHook(phasesCtrl, phasesMap, importLine);

// 2. Sprints
const sprintsCtrl = path.join(__dirname, 'src', 'modules', 'sprints', 'sprints.controller.ts');
const sprintsMap = {
    'SPRINT_STARTED': "await NotificationEvents.notifySprintEvent(tenantId, req.user!.id, result, 'SPRINT_STARTED', 'Sprint Started');",
    'SPRINT_CLOSED': "await NotificationEvents.notifySprintEvent(tenantId, req.user!.id, result, 'SPRINT_CLOSED', 'Sprint Closed');",
    'SPRINT_REOPENED': "await NotificationEvents.notifySprintEvent(tenantId, req.user!.id, result, 'SPRINT_REOPENED', 'Sprint Reopened');"
};
insertNotificationHook(sprintsCtrl, sprintsMap, importLine);

// 3. Gates
const gatesCtrl = path.join(__dirname, 'src', 'modules', 'gates', 'gates.controller.ts');
const gatesMap = {
    'GATE_APPROVED': "await NotificationEvents.notifyGateEvent(tenantId, req.user!.id, result, 'GATE_APPROVED', 'Gate Approved');",
    'GATE_REJECTED': "await NotificationEvents.notifyGateEvent(tenantId, req.user!.id, result, 'GATE_REJECTED', 'Gate Rejected');",
    'GATE_RESUBMITTED': "await NotificationEvents.notifyGateEvent(tenantId, req.user!.id, result, 'GATE_RESUBMITTED', 'Gate Resubmitted');"
};
insertNotificationHook(gatesCtrl, gatesMap, importLine);

console.log("Notification hooks injected into controllers.");
