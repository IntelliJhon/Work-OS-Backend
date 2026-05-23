import { db } from './db';
import { users } from './db/schema/users';
import { roles } from './db/schema/roles';
import { projectMembers } from './db/schema/project_members';
import { tenants } from './db/schema/tenants';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('--- FETCHING ALL TENANTS ---');
  const allTenants = await db.select().from(tenants);
  
  for (const tenant of allTenants) {
    // Only query if the slug looks like the active one or if we want to search for the user pm@acme.com
    console.log(`\n=================== TENANT: ${tenant.name} (${tenant.slug}) [${tenant.id}] ===================`);
    
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`);
      
      const tRoles = await tx.select().from(roles);
      console.log('Roles:', tRoles);
      
      const tUsers = await tx.select().from(users);
      console.log('Users:', tUsers.map((u: any) => ({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        roleId: u.roleId
      })));
      
      const tMembers = await tx.select().from(projectMembers);
      console.log('Project Members:', tMembers);
    });
  }

  process.exit(0);
}

main().catch(console.error);
