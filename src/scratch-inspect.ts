import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzleServerless } from 'drizzle-orm/neon-serverless';
import { env } from './config/env';
import { users } from './db/schema/users';
import { roles } from './db/schema/roles';
import { tasks } from './db/schema/tasks';
import { projects } from './db/schema/projects';
import { projectMembers } from './db/schema/project_members';
import { eq } from 'drizzle-orm';

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL_DIRECT });
  const directDb = drizzleServerless(pool);

  console.log("--- Users ---");
  const allUsers = await directDb.select().from(users);
  for (const u of allUsers) {
    const [r] = await directDb.select().from(roles).where(eq(roles.id, u.roleId || ''));
    console.log(`User ID: ${u.id} | Email: ${u.email} | Role: ${r ? r.name : 'None'} | Tenant ID: ${u.tenantId}`);
  }

  console.log("\n--- Projects ---");
  const allProjects = await directDb.select().from(projects);
  for (const p of allProjects) {
    console.log(`Project ID: ${p.id} | Name: ${p.name} | PM ID: ${p.pmId}`);
  }

  console.log("\n--- Project Members ---");
  const allMembers = await directDb.select().from(projectMembers);
  for (const m of allMembers) {
    const [r] = await directDb.select().from(roles).where(eq(roles.id, m.roleId || ''));
    console.log(`Project ID: ${m.projectId} | User ID: ${m.userId} | Role: ${r ? r.name : 'None'}`);
  }

  console.log("\n--- Tasks ---");
  const allTasks = await directDb.select().from(tasks);
  for (const t of allTasks) {
    console.log(`Task ID: ${t.id} | Name: ${t.name} | Assignee ID: ${t.assigneeId} | Project ID: ${t.projectId} | Sprint ID: ${t.sprintId} | Status: ${t.status}`);
  }

  await pool.end();
  process.exit(0);
}

main().catch(console.error);
