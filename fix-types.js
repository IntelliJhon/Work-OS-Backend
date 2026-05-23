const fs = require('fs');
const path = require('path');

function replaceInFile(filePath, replacements) {
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, 'utf8');
    for (const [search, replace] of replacements) {
        content = content.split(search).join(replace);
    }
    fs.writeFileSync(filePath, content, 'utf8');
}

const gatesCtrl = path.join(__dirname, 'src', 'modules', 'gates', 'gates.controller.ts');
replaceInFile(gatesCtrl, [
    ['const gateId = req.params.id;', 'const gateId = req.params.id as string;'],
    ['const projectId = req.params.projectId;', 'const projectId = req.params.projectId as string;']
]);

const phasesCtrl = path.join(__dirname, 'src', 'modules', 'phases', 'phases.controller.ts');
replaceInFile(phasesCtrl, [
    ['const phaseId = req.params.id;', 'const phaseId = req.params.id as string;']
]);

const sprintsCtrl = path.join(__dirname, 'src', 'modules', 'sprints', 'sprints.controller.ts');
replaceInFile(sprintsCtrl, [
    ['const sprintId = req.params.id;', 'const sprintId = req.params.id as string;']
]);

const phasesSvc = path.join(__dirname, 'src', 'modules', 'phases', 'phases.service.ts');
replaceInFile(phasesSvc, [
    ['allPhases.find(p =>', 'allPhases.find((p: any) =>'],
    ['previousPhase = allPhases.find(p =>', 'previousPhase = allPhases.find((p: any) =>'],
    ['nextPhase = allPhases.find(p =>', 'nextPhase = allPhases.find((p: any) =>']
]);

const projSvc = path.join(__dirname, 'src', 'modules', 'projects', 'projects.service.ts');
replaceInFile(projSvc, [
    ['phases.map((phase, index)', 'phases.map((phase: any, index: number)']
]);

console.log("Types fixed.");
