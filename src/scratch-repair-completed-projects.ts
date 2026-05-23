import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzleServerless } from 'drizzle-orm/neon-serverless';
import { env } from './config/env';
import { projects } from './db/schema/projects';
import { phases } from './db/schema/phases';
import { eq, and } from 'drizzle-orm';

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL_DIRECT });
  const directDb = drizzleServerless(pool);

  console.log("Starting database repair: Updating project status based on phase completion...");

  const allProjects = await directDb.select().from(projects);
  for (const p of allProjects) {
    const projectPhases = await directDb.select().from(phases).where(eq(phases.projectId, p.id));
    const allCompleted = projectPhases.length > 0 && projectPhases.every(ph => ph.status === 'completed');
    
    if (p.status === 'completed' && !allCompleted) {
      console.log(`\nRepairing Project ID: ${p.id} | Name: ${p.name}`);
      console.log(`  Current Status: ${p.status}`);
      console.log(`  Phase Progress: ${projectPhases.filter(ph => ph.status === 'completed').length} of ${projectPhases.length} completed`);
      
      const [updated] = await directDb.update(projects)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(projects.id, p.id))
        .returning();
        
      console.log(`  Updated Status: ${updated.status}`);
    }
  }

  console.log("\nDatabase repair completed successfully.");
  await pool.end();
  process.exit(0);
}

main().catch(console.error);
