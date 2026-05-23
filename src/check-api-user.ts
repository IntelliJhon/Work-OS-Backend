import { db } from './db';
import { sql } from 'drizzle-orm';

async function checkApiUser() {
  const roles = await db.execute(sql`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'api_user';`);
  console.log('API User Role:', roles.rows[0]);

  // Let's also check if RLS is enabled on the tasks table
  const rls = await db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tasks';`);
  console.log('Tasks Table RLS:', rls.rows[0]);

  process.exit(0);
}

checkApiUser();
