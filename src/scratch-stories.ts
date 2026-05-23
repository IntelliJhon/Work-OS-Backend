import { db } from './db';
import { stories } from './db/schema/stories';
import { eq } from 'drizzle-orm';
import { withTenant } from './middleware/tenant.middleware';

async function main() {
  const tenantId = 'fda80ed9-f995-4e51-9a72-9484f07e075b';

  console.log(`Fetching all stories in DB for tenant ${tenantId}...`);
  await withTenant(tenantId, async (tx) => {
    const allStories = await tx.select().from(stories);
    console.log('--- ALL STORIES ---');
    console.log(allStories.map((s: any) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId
    })));
  });

  process.exit(0);
}

main().catch(console.error);
