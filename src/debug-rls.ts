import { db } from './db';
import { tasks } from './db/schema/tasks';
import { sql } from 'drizzle-orm';
import { withTenant } from './middleware/tenant.middleware';

async function debug() {
  console.log('--- DIRECT SELECT WITHOUT WITH_TENANT ---');
  const allTasks = await db.select().from(tasks);
  console.log('Direct Tasks count:', allTasks.length);

  const [tenantA] = await db.select( { id: tasks.tenantId } ).from(tasks).limit(1);
  if (!tenantA) {
    console.log('No tasks found, cannot test further');
    process.exit(0);
  }

  console.log('--- DIRECT SELECT WITH WHERE CLAUSE ---');
  const whereTasks = await db.select().from(tasks).where(sql`${tasks.tenantId} = ${tenantA.id}`);
  console.log('Where Tasks count:', whereTasks.length);

  console.log('--- SELECT WITH WITH_TENANT (Tenant A) ---');
  const tenantATasks = await withTenant(tenantA.id, async (tx) => {
    return await tx.select().from(tasks);
  });
  console.log('Tenant A Tasks count:', tenantATasks.length);

  console.log('--- SELECT WITH WITH_TENANT (Tenant B) ---');
  const fakeTenantB = '00000000-0000-0000-0000-000000000000';
  const tenantBTasks = await withTenant(fakeTenantB, async (tx) => {
    return await tx.select().from(tasks);
  });
  console.log('Tenant B Tasks count:', tenantBTasks.length);

  process.exit(0);
}

debug();
