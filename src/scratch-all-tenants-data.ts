import { db } from './db';
import { sql } from 'drizzle-orm';
import { withTenant } from './middleware/tenant.middleware';
import { projects } from './db/schema/projects';
import { phases } from './db/schema/phases';
import { sprints } from './db/schema/sprints';
import { qualityGates } from './db/schema/quality_gates';

async function main() {
  console.log('Querying all tenants first...');
  const allTenantsResult = await db.execute(sql`SELECT * FROM tenants`);
  const tenantsList = allTenantsResult.rows as any[];

  console.log(`Found ${tenantsList.length} tenants. Fetching data for each tenant with set_config...`);

  for (const tenant of tenantsList) {
    console.log(`\n================ TENANT: ${tenant.name} (${tenant.id}) ================`);
    try {
      await withTenant(tenant.id, async (tx) => {
        const allProj = await tx.select().from(projects);
        console.log(`--- PROJECTS (${allProj.length}) ---`);
        console.log(allProj.map((p: any) => ({ id: p.id, name: p.name, pmId: p.pmId })));

        const allPhase = await tx.select().from(phases);
        console.log(`--- PHASES (${allPhase.length}) ---`);
        console.log(allPhase.map((p: any) => ({ id: p.id, projectId: p.projectId, name: p.name, status: p.status, isLocked: p.isLocked, orderIndex: p.orderIndex })));

        const allSprint = await tx.select().from(sprints);
        console.log(`--- SPRINTS (${allSprint.length}) ---`);
        console.log(allSprint.map((s: any) => ({ id: s.id, projectId: s.projectId, phaseId: s.phaseId, name: s.name, status: s.status })));

        const allGate = await tx.select().from(qualityGates);
        console.log(`--- GATES (${allGate.length}) ---`);
        console.log(allGate.map((g: any) => ({ id: g.id, projectId: g.projectId, phaseId: g.phaseId, status: g.status })));
      });
    } catch (e: any) {
      console.error(`Failed to fetch for tenant ${tenant.name}:`, e.message);
    }
  }

  process.exit(0);
}

main().catch(console.error);
