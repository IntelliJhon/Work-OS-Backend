import { db } from './db';
import { sql } from 'drizzle-orm';

async function checkMigrations() {
  const migrations = await db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at;`);
  console.log('Applied Migrations:', migrations.rows);
  process.exit(0);
}

checkMigrations();
