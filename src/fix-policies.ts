import { env } from './config/env';
import { neon } from '@neondatabase/serverless';

async function fixPolicies() {
  const sql = neon(env.DATABASE_URL_DIRECT);
  const tables = ['roles', 'users', 'projects', 'phases', 'sprints', 'epics', 'stories', 'tasks', 'audit_log', 'refresh_tokens'];
  
  for (const table of tables) {
    await sql.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON "${table}";`);
    await sql.query(`
      CREATE POLICY tenant_isolation_policy ON "${table}"
      AS PERMISSIVE FOR ALL
      USING (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.current_tenant_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);
    `);
    console.log(`Fixed policy for ${table}`);
  }
  
  process.exit(0);
}

fixPolicies();
