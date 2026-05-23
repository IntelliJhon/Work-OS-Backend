import { Pool } from '@neondatabase/serverless';
import { drizzle as drizzleServerless } from 'drizzle-orm/neon-serverless';
import { env } from './config/env';
import { users } from './db/schema/users';
import { tenants } from './db/schema/tenants';
import { eq } from 'drizzle-orm';

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL_DIRECT });
  const directDb = drizzleServerless(pool);

  console.log("--- Users and Tenants ---");
  const allUsers = await directDb.select().from(users);
  for (const u of allUsers) {
    const [t] = await directDb.select().from(tenants).where(eq(tenants.id, u.tenantId));
    console.log(`Email: ${u.email} | Tenant ID: ${u.tenantId} | Tenant Name: ${t ? t.name : 'Unknown'} | Slug: ${t ? t.slug : 'None'}`);
  }

  await pool.end();
  process.exit(0);
}

main().catch(console.error);
