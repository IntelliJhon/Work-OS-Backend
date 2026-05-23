import { db } from '../index';
import { tenants } from '../schema/tenants';
import { roles } from '../schema/roles';
import { users } from '../schema/users';
import bcrypt from 'bcrypt';
import { sql } from 'drizzle-orm';

async function seed() {
  console.log('🌱 Starting database seed...');

  try {
    // 1. Create a Tenant with a unique slug
    const uniqueSlug = `acme-corporation-${Date.now()}`;
    const [tenant] = await db.insert(tenants).values({
      name: 'Acme Corporation',
      slug: uniqueSlug,
    }).returning();
    console.log(`✅ Created Tenant: ${tenant.name} (${uniqueSlug})`);

    // Set tenant context for the rest of seeding using a transaction
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`);

      // 2. Create Roles
      const [adminRole] = await tx.insert(roles).values({
        tenantId: tenant.id,
        name: 'Admin',
        permissions: {
          'task.create': true,
          'task.read': true,
          'task.update': true,
          'project.create': true,
          'project.read': true,
          'project.manage': true,
        },
      }).returning();

      const [userRole] = await tx.insert(roles).values({
        tenantId: tenant.id,
        name: 'User',
        permissions: {
          'task.create': false,
          'task.read': true,
          'task.update': true,
          'project.create': false,
          'project.read': true,
        },
      }).returning();
      console.log(`✅ Created Roles`);

      // 3. Create Users
      const passwordHash = await bcrypt.hash('Password123!', 10);
      const [adminUser] = await tx.insert(users).values({
        tenantId: tenant.id,
        email: 'admin@acme.com',
        passwordHash,
        firstName: 'Admin',
        lastName: 'Acme',
        roleId: adminRole.id,
      }).returning();

      console.log(`✅ Created Admin User: ${adminUser.email}`);
    });

    console.log(`\nSeed completed successfully!`);
    console.log(`You can now login with email: 'admin@acme.com' and password: 'Password123!'`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  }
}

seed();
