import { db } from './db';
import { sql } from 'drizzle-orm';

async function checkTenants() {
  const rls = await db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tenants';`);
  console.log('Tenants Table RLS:', rls.rows[0]);
  process.exit(0);
}

checkTenants();
