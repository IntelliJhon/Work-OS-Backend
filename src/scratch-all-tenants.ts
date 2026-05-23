import { db } from './db';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Querying all tenants, projects, phases, sprints, quality_gates across the database...');

  // Query raw tables because withTenant restricts to a single tenant
  const allTenants = await db.execute(sql`SELECT * FROM tenants`);
  console.log('--- ALL TENANTS ---');
  console.log(allTenants.rows);

  const allProjects = await db.execute(sql`SELECT id, tenant_id, name, pm_id FROM projects`);
  console.log('--- ALL PROJECTS ---');
  console.log(allProjects.rows);

  const allPhases = await db.execute(sql`SELECT id, tenant_id, project_id, name, order_index, status, is_locked FROM phases`);
  console.log('--- ALL PHASES ---');
  console.log(allPhases.rows);

  const allSprints = await db.execute(sql`SELECT id, tenant_id, project_id, phase_id, name, status FROM sprints`);
  console.log('--- ALL SPRINTS ---');
  console.log(allSprints.rows);

  const allGates = await db.execute(sql`SELECT id, tenant_id, project_id, phase_id, status FROM quality_gates`);
  console.log('--- ALL GATES ---');
  console.log(allGates.rows);

  process.exit(0);
}

main().catch(console.error);
