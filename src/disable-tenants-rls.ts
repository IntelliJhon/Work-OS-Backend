import { env } from './config/env';
import { neon } from '@neondatabase/serverless';

async function disableTenantsRls() {
  const sql = neon(env.DATABASE_URL_DIRECT);
  await sql`ALTER TABLE "tenants" DISABLE ROW LEVEL SECURITY;`;
  console.log('Disabled RLS on tenants');
  process.exit(0);
}

disableTenantsRls();
