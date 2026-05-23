import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzleServerless } from 'drizzle-orm/neon-serverless';
import { env } from './config/env';
import { projects } from './db/schema/projects';
import { phases } from './db/schema/phases';
import { qualityGates } from './db/schema/quality_gates';
import { eq } from 'drizzle-orm';

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL_DIRECT });
  const directDb = drizzleServerless(pool);

  console.log("--- Projects ---");
  const allProjects = await directDb.select().from(projects);
  for (const p of allProjects) {
    console.log(`\nProject ID: ${p.id} | Name: ${p.name} | Status: ${p.status}`);
    
    console.log("  Phases:");
    const projectPhases = await directDb.select().from(phases).where(eq(phases.projectId, p.id));
    for (const ph of projectPhases) {
      console.log(`    Phase: ${ph.name} | Status: ${ph.status} | Locked: ${ph.isLocked}`);
    }

    console.log("  Quality Gates:");
    const projectGates = await directDb.select().from(qualityGates).where(eq(qualityGates.projectId, p.id));
    for (const gt of projectGates) {
      console.log(`    Gate: PhaseID: ${gt.phaseId} | Status: ${gt.status} | Criteria: ${JSON.stringify(gt.criteria)}`);
    }
  }

  await pool.end();
  process.exit(0);
}

main().catch(console.error);
