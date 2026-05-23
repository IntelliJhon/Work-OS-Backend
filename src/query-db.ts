import { db } from './db';
import { users } from './db/schema/users';
import { tenants } from './db/schema/tenants';
import { roles } from './db/schema/roles';
import { projectMembers } from './db/schema/project_members';
import { withTenant } from './middleware/tenant.middleware';
import { sql } from 'drizzle-orm';

async function run() {
  try {
    const tenantId = 'fda80ed9-f995-4e51-9a72-9484f07e075b';
    console.log('Querying for tenant:', tenantId);

    await withTenant(tenantId, async (tx) => {
      console.log('--- TENANTS ---');
      const allTenants = await tx.select().from(tenants);
      console.log(allTenants);

      console.log('\n--- ROLES ---');
      const allRoles = await tx.select().from(roles);
      console.log(allRoles);

      console.log('\n--- USERS ---');
      const allUsers = await tx.select().from(users);
      console.log(allUsers);

      console.log('\n--- PROJECT MEMBERS ---');
      const allMembers = await tx.select().from(projectMembers);
      console.log(allMembers);
    });

    process.exit(0);
  } catch (err) {
    console.error('Error querying db:', err);
    process.exit(1);
  }
}

run();
