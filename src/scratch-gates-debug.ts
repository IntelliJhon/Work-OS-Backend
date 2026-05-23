import { db } from './db';
import { phases } from './db/schema/phases';
import { sprints } from './db/schema/sprints';
import { qualityGates } from './db/schema/quality_gates';
import { eq } from 'drizzle-orm';
import { withTenant } from './middleware/tenant.middleware';

async function main() {
  const tenantId = 'fda80ed9-f995-4e51-9a72-9484f07e075b';
  await withTenant(tenantId, async (tx) => {
    const allGates = await tx.select().from(qualityGates);
    console.log('--- ALL QUALITY GATES ---');
    console.log(allGates.map((g: any) => ({
      id: g.id,
      projectId: g.projectId,
      phaseId: g.phaseId,
      status: g.status,
      approvedBy: g.approvedBy,
    })));

    const allPhases = await tx.select().from(phases);
    console.log('--- ALL PHASES ---');
    console.log(allPhases.map((p: any) => ({
      id: p.id,
      projectId: p.projectId,
      name: p.name,
      status: p.status,
      isLocked: p.isLocked,
      orderIndex: p.orderIndex,
    })));

    const allSprints = await tx.select().from(sprints);
    console.log('--- ALL SPRINTS ---');
    console.log(allSprints.map((s: any) => ({
      id: s.id,
      projectId: s.projectId,
      phaseId: s.phaseId,
      name: s.name,
      status: s.status,
    })));
  });
  process.exit(0);
}

main().catch(console.error);
