import { db } from './db';
import { sql } from 'drizzle-orm';

async function createRole() {
  try {
    // Note: Creating roles in Neon might require specific privileges.
    // neondb_owner is the owner so it should work.
    await db.execute(sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_user') THEN
        CREATE ROLE api_user WITH LOGIN PASSWORD 'api_secure_pass123';
      END IF;
    END $$;`);
    
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO api_user;`);
    await db.execute(sql`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO api_user;`);
    await db.execute(sql`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO api_user;`);
    await db.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO api_user;`);
    await db.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO api_user;`);
    
    console.log('Role api_user created and granted privileges.');
  } catch (err: any) {
    console.log('Error creating role:', err.message);
  }
  process.exit(0);
}

createRole();
