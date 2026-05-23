import { db } from './db';
import { sql } from 'drizzle-orm';

async function checkUser() {
  const result = await db.execute(sql`SELECT current_user;`);
  console.log('Current connection user:', result.rows[0].current_user);
  process.exit(0);
}

checkUser();
