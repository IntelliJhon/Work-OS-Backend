import { db } from './db';
import { phases } from './db/schema/phases';
import { sprints } from './db/schema/sprints';
import { qualityGates } from './db/schema/quality_gates';
import { eq, and } from 'drizzle-orm';
import { withTenant } from './middleware/tenant.middleware';

async function main() {
  const tenantId = 'fda80ed9-f995-4e51-9a72-9484f07e075b';
  const projectId = '52d4295d-69c1-4568-85a1-19e90253f506';

  console.log(`Fetching phases, gates, sprints for project ${projectId}...`);
  await withTenant(tenantId, async (tx) => {
    const projectPhases = await tx.select().from(phases).where(and(eq(phases.projectId, projectId), eq(phases.tenantId, tenantId)));
    const projectGates = await tx.select().from(qualityGates).where(and(eq(qualityGates.projectId, projectId), eq(qualityGates.tenantId, tenantId)));
    const projectSprints = await tx.select().from(sprints).where(and(eq(sprints.projectId, projectId), eq(sprints.tenantId, tenantId)));

    console.log('--- PHASES ---');
    console.log(projectPhases.map((p: any) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      isLocked: p.isLocked,
      orderIndex: p.orderIndex
    })));

    console.log('--- GATES ---');
    console.log(projectGates.map((g: any) => ({
      id: g.id,
      phaseId: g.phaseId,
      status: g.status
    })));

    console.log('--- SPRINTS ---');
    console.log(projectSprints.map((s: any) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      phaseId: s.phaseId
    })));
  });

  process.exit(0);
}

main().catch(console.error);
