import { db } from './db';
import { sql } from 'drizzle-orm';

async function alterRole() {
  try {
    await db.execute(sql`ALTER ROLE neondb_owner NOBYPASSRLS;`);
    console.log('Successfully removed BYPASSRLS from neondb_owner');
  } catch (err: any) {
    console.log('Failed to alter role:', err.message);
  }
  process.exit(0);
}

alterRole();
