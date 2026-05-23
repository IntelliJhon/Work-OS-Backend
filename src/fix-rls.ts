import { db } from './db';
import { sql } from 'drizzle-orm';

async function fix() {
  await db.execute(sql`ALTER TABLE tasks FORCE ROW LEVEL SECURITY;`);
  console.log('Applied FORCE ROW LEVEL SECURITY to tasks');
  process.exit(0);
}

fix();
