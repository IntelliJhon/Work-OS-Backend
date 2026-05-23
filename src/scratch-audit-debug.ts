import { db } from './db';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Querying latest audit logs...');
  const logs = await db.execute(sql`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 20`);
  console.log(logs.rows);
  process.exit(0);
}

main().catch(console.error);
