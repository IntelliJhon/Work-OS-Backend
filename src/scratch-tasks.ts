import { db } from './db';
import { tasks } from './db/schema/tasks';
import { eq } from 'drizzle-orm';
import { withTenant } from './middleware/tenant.middleware';

async function main() {
  const tenantId = 'fda80ed9-f995-4e51-9a72-9484f07e075b';

  console.log(`Fetching all tasks in DB for tenant ${tenantId}...`);
  await withTenant(tenantId, async (tx) => {
    const allTasks = await tx.select().from(tasks);
    console.log('--- ALL TASKS ---');
    console.log(allTasks.map((t: any) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      sprintId: t.sprintId,
      projectId: t.projectId
    })));
  });

  process.exit(0);
}

main().catch(console.error);
