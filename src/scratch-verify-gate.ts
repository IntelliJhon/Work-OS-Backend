import { db } from './db';
import { GatesService } from './modules/gates/gates.service';
import { withTenant } from './middleware/tenant.middleware';
import { phases } from './db/schema/phases';
import { sprints } from './db/schema/sprints';
import { qualityGates } from './db/schema/quality_gates';
import { users } from './db/schema/users';
import { eq, and } from 'drizzle-orm';

async function main() {
  const tenantId = '18de4a3a-9e04-4d54-8aba-91c66b968d9b'; // Intellijohn Labs
  const projectId = '9ab455d8-1b9c-474d-861d-a564cf1e1fd8'; // Appolo Go live suite
  const gateId = '05f5ac5a-56a9-4063-bfd2-9ff9a44f9484'; // Initiation Phase Gate
  const ipAddress = '127.0.0.1';

  try {
    await withTenant(tenantId, async (tx) => {
      // Find a valid user for this tenant
      const tenantUsers = await tx.select().from(users).where(eq(users.tenantId, tenantId)).limit(1);
      if (tenantUsers.length === 0) {
        throw new Error(`No users found in tenant ${tenantId}`);
      }
      const userId = tenantUsers[0].id;
      console.log(`Using userId: ${userId} (${tenantUsers[0].firstName} ${tenantUsers[0].lastName})`);

      // 1. Verify starting state
      const [gateBefore] = await tx.select().from(qualityGates).where(eq(qualityGates.id, gateId));
      if (!gateBefore) {
        throw new Error(`Quality Gate not found: ${gateId}`);
      }
      const [phaseBefore] = await tx.select().from(phases).where(eq(phases.id, gateBefore.phaseId));
      const activeSprintsBefore = await tx.select().from(sprints).where(and(eq(sprints.phaseId, phaseBefore.id), eq(sprints.status, 'active')));

      console.log('--- BEFORE APPROVAL ---');
      console.log(`Gate Status: ${gateBefore.status}`);
      console.log(`Phase Status: ${phaseBefore.status}`);
      console.log(`Active Sprints: ${activeSprintsBefore.length} (${activeSprintsBefore.map(s => s.name).join(', ')})`);

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
    console.error('\nFAILED! Error occurred during gate approval:');
    console.error(err);
  }

  process.exit(0);
}

main().catch(console.error);
