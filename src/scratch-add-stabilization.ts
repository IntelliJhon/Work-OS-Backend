import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzleServerless } from 'drizzle-orm/neon-serverless';
import { env } from './config/env';
import { projects } from './db/schema/projects';
import { phases } from './db/schema/phases';
import { qualityGates } from './db/schema/quality_gates';
import { eq, and } from 'drizzle-orm';

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL_DIRECT });
  const directDb = drizzleServerless(pool);

  console.log("Starting migration: Adding 'Stabilization' phase to existing projects...");

  const allProjects = await directDb.select().from(projects);
  for (const p of allProjects) {
    const projectPhases = await directDb.select().from(phases).where(eq(phases.projectId, p.id));
    const hasStabilization = projectPhases.some(ph => ph.name === 'Stabilization');
    
    // We only migrate projects that have exactly 6 phases (i.e. default project structure)
    // and don't already have 'Stabilization'.
    if (projectPhases.length === 6 && !hasStabilization) {
      console.log(`\nMigrating Project ID: ${p.id} | Name: ${p.name}`);
      
      // 1. Insert the new phase 'Stabilization'
      const [newPhase] = await directDb.insert(phases).values({
        tenantId: p.tenantId,
        projectId: p.id,
        name: 'Stabilization',
        orderIndex: 7,
        status: 'pending',
        isLocked: true,
      }).returning();

      console.log(`  Added Phase: ${newPhase.name} (ID: ${newPhase.id})`);

      // 2. Insert the Quality Gate for the new phase
      const [newGate] = await directDb.insert(qualityGates).values({
        tenantId: p.tenantId,
        projectId: p.id,
        phaseId: newPhase.id,
        criteria: {
          'Post-launch monitoring completed': false,
          'Feedback loop established': false,
        },
        status: 'pending',
      }).returning();

      console.log(`  Added Quality Gate for Phase (ID: ${newGate.id})`);
    } else {
      console.log(`Skipping Project ID: ${p.id} | Name: ${p.name} (Phases Count: ${projectPhases.length}, Has Stabilization: ${hasStabilization})`);
    }
  }

  console.log("\nMigration completed successfully.");
  await pool.end();
  process.exit(0);
}

main().catch(console.error);
