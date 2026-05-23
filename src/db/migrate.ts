import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import { env } from '../config/env';

const sql = neon(env.DATABASE_URL_DIRECT);
const db = drizzle(sql);

async function main() {
  console.log('⏳ Running migrations...');
  const start = Date.now();
  try {
    await migrate(db, { migrationsFolder: 'src/db/migrations' });
    const end = Date.now();
    console.log(`✅ Migrations completed in ${end - start}ms`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

main();
