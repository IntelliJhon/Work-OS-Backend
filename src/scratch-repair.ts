import { db } from './db';
import { phases } from './db/schema/phases';
import { qualityGates } from './db/schema/quality_gates';
import { eq, and } from 'drizzle-orm';
import { withTenant } from './middleware/tenant.middleware';

async function main() {
  const tenantId = 'fda80ed9-f995-4e51-9a72-9484f07e075b';
  const projectId = '52d4295d-69c1-4568-85a1-19e90253f506';

  const initiationGateId = '2bcdb2b6-76e5-4b55-83a0-14d59ab3480f';
  const planningPhaseId = 'e0db726b-fb8d-4ed8-aa64-11f0cc21094d';

  console.log(`Repairing database state for project ${projectId}...`);
  
  await withTenant(tenantId, async (tx) => {
    // 1. Reset initiation quality gate to pending
    console.log(`Resetting Initiation phase quality gate (${initiationGateId}) to pending...`);
    await tx.update(qualityGates)
      .set({
        status: 'pending',
        approvedBy: null,
        approvedAt: null,
        updatedAt: new Date()
      })
      .where(and(eq(qualityGates.id, initiationGateId), eq(qualityGates.tenantId, tenantId)));

    // 2. Lock subsequent Planning phase
    console.log(`Locking subsequent Planning phase (${planningPhaseId})...`);
    await tx.update(phases)
      .set({
        isLocked: true,
        status: 'pending',
        updatedAt: new Date()
      })
      .where(and(eq(phases.id, planningPhaseId), eq(phases.tenantId, tenantId)));
  });

  console.log('Database repair completed successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error running database repair:', err);
  process.exit(1);
});
