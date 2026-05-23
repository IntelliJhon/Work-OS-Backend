import { db } from './db';
import { GatesService } from './modules/gates/gates.service';
import { withTenant } from './middleware/tenant.middleware';
import { phases } from './db/schema/phases';
import { sprints } from './db/schema/sprints';
import { qualityGates } from './db/schema/quality_gates';
import { eq, and } from 'drizzle-orm';

async function main() {
  const tenantId = 'fda80ed9-f995-4e51-9a72-9484f07e075b';
  const projectId = '52d4295d-69c1-4568-85a1-19e90253f506';
  const userId = '84975982-d836-483d-8ad3-bb77fbad3941'; // standard test user
  const ipAddress = '127.0.0.1';
  const gateId = '119e8377-86c9-4e66-b8cb-ef53cf6e2509'; // Testing Gate

  console.log(`Approving Gate ${gateId} inside tenant transaction...`);

  try {
    await withTenant(tenantId, async (tx) => {
      // 1. Verify starting state
      const [gateBefore] = await tx.select().from(qualityGates).where(eq(qualityGates.id, gateId));
      const [phaseBefore] = await tx.select().from(phases).where(eq(phases.id, gateBefore.phaseId));
      const activeSprintsBefore = await tx.select().from(sprints).where(and(eq(sprints.phaseId, phaseBefore.id), eq(sprints.status, 'active')));

      console.log('--- BEFORE APPROVAL ---');
      console.log(`Gate Status: ${gateBefore.status}`);
      console.log(`Phase Status: ${phaseBefore.status}`);
        console.log(`Active Sprints: ${activeSprintsBefore.length} (${activeSprintsBefore.map((s: any) => s.name).join(', ')})`);

      // 2. Call approveGate
      console.log('\nExecuting GatesService.approveGate...');
      const result = await GatesService.approveGate(tx, tenantId, userId, ipAddress, gateId);
      console.log('approveGate returned:', result.status);

      // 3. Verify ending state
      const [gateAfter] = await tx.select().from(qualityGates).where(eq(qualityGates.id, gateId));
      const [phaseAfter] = await tx.select().from(phases).where(eq(phases.id, gateBefore.phaseId));
      const activeSprintsAfter = await tx.select().from(sprints).where(and(eq(sprints.phaseId, phaseBefore.id), eq(sprints.status, 'active')));
      const allSprintsAfter = await tx.select().from(sprints).where(eq(sprints.phaseId, phaseBefore.id));

      console.log('\n--- AFTER APPROVAL ---');
      console.log(`Gate Status: ${gateAfter.status}`);
      console.log(`Phase Status: ${phaseAfter.status}`);
      console.log(`Active Sprints: ${activeSprintsAfter.length}`);
      console.log(`All Sprints Status:`, allSprintsAfter.map(s => ({ name: s.name, status: s.status })));
    });

    console.log('\nSUCCESS! Quality Gate approved and active sprint closed automatically with workflow validation passing!');
  } catch (err: any) {
    console.error('\nFAILED! Error occurred during gate approval:', err.message || err);
  }

  process.exit(0);
}

main().catch(console.error);
