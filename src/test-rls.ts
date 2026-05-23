import { db } from './db';
import { tasks } from './db/schema/tasks';
import { tenants } from './db/schema/tenants';
import { users } from './db/schema/users';
import { roles } from './db/schema/roles';
import { withTenant } from './middleware/tenant.middleware';
import { sql } from 'drizzle-orm';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { projects } from './db/schema/projects';
import { stories } from './db/schema/stories';
import { epics } from './db/schema/epics';

async function runTests() {
  console.log('🧪 Starting RLS Simulation Tests...');

  // 1. Setup Tenant A and Tenant B
  const [tenantA] = await db.insert(tenants).values({ name: 'Tenant A', slug: 'tenant-a' }).returning();
  const [tenantB] = await db.insert(tenants).values({ name: 'Tenant B', slug: 'tenant-b' }).returning();
  console.log(`✅ Created Tenant A (${tenantA.id}) and Tenant B (${tenantB.id})`);

  // Setup base entities using the tenant context
  const { roleA, userA, projectA, epicA, storyA } = await withTenant(tenantA.id, async (tx) => {
    const [roleA] = await tx.insert(roles).values({ tenantId: tenantA.id, name: 'Admin A' }).returning();
    const [userA] = await tx.insert(users).values({
      tenantId: tenantA.id, roleId: roleA.id, email: `a${crypto.randomUUID()}@a.com`, passwordHash: 'hash', firstName: 'A', lastName: 'A'
    }).returning();

    const [projectA] = await tx.insert(projects).values({ tenantId: tenantA.id, name: 'Project A' }).returning();
    const [epicA] = await tx.insert(epics).values({ tenantId: tenantA.id, projectId: projectA.id, name: 'Epic A' }).returning();
    const [storyA] = await tx.insert(stories).values({ tenantId: tenantA.id, epicId: epicA.id, projectId: projectA.id, name: 'Story A' }).returning();
    
    return { roleA, userA, projectA, epicA, storyA };
  });

  let taskAId = '';
  // Test 1: Tenant A inserts a task inside its context
  try {
    const taskA = await withTenant(tenantA.id, async (tx) => {
      const [inserted] = await tx.insert(tasks).values({
        tenantId: tenantA.id,
        projectId: projectA.id,
        storyId: storyA.id,
        name: 'Task strictly for Tenant A',
      }).returning();
      return inserted;
    });
    taskAId = taskA.id;
    console.log('✅ Test 1 Passed: Tenant A successfully inserted a task.');
  } catch (err: any) {
    console.log('❌ Test 1 Failed:', err.message);
  }

  // Test 2: Tenant B tries to read Tenant A data
  try {
    const results = await withTenant(tenantB.id, async (tx) => {
      return await tx.select().from(tasks);
    });
    if (results.length === 0) {
      console.log('✅ Test 2 Passed: Tenant B cannot read Tenant A data (0 rows returned).');
    } else {
      console.log('❌ Test 2 Failed: Tenant B read leaked data!', results);
    }
  } catch (err: any) {
    console.log('❌ Test 2 Failed:', err.message);
  }

  // Test 3: Tenant B tries to update Tenant A data
  try {
    const updateResult = await withTenant(tenantB.id, async (tx) => {
      return await tx.update(tasks).set({ name: 'Hacked by B' }).where(sql`${tasks.id} = ${taskAId}`).returning();
    });
    if (updateResult.length === 0) {
      console.log('✅ Test 3 Passed: Tenant B cannot update Tenant A data (0 rows affected).');
    } else {
      console.log('❌ Test 3 Failed: Tenant B updated Tenant A data!', updateResult);
    }
  } catch (err: any) {
    console.log('❌ Test 3 Failed:', err.message);
  }

  // Test 4: Tenant B tries to delete Tenant A data
  try {
    const deleteResult = await withTenant(tenantB.id, async (tx) => {
      return await tx.delete(tasks).where(sql`${tasks.id} = ${taskAId}`).returning();
    });
    if (deleteResult.length === 0) {
      console.log('✅ Test 4 Passed: Tenant B cannot delete Tenant A data (0 rows affected).');
    } else {
      console.log('❌ Test 4 Failed: Tenant B deleted Tenant A data!', deleteResult);
    }
  } catch (err: any) {
    console.log('❌ Test 4 Failed:', err.message);
  }

  // Test 5: Missing tenant_id in query (Direct access)
  try {
    // Calling db.select() directly outside of withTenant() block (no transaction, no SET LOCAL)
    const directResults = await db.select().from(tasks);
    if (directResults.length === 0) {
      console.log('✅ Test 5 Passed: Direct query without tenant context blocked (0 rows).');
    } else {
      console.log('❌ Test 5 Failed: Direct query returned data! Leaked rows: ', directResults.length);
    }
  } catch (err: any) {
    console.log('✅ Test 5 Passed (Threw Error):', err.message);
  }
  
  // Test 6: Tenant A attempts to insert data for Tenant B
  try {
    await withTenant(tenantA.id, async (tx) => {
      await tx.insert(tasks).values({
        tenantId: tenantB.id, // Forging the tenant_id
        projectId: projectA.id,
        storyId: storyA.id,
        name: 'Forged Task',
      }).returning();
    });
    console.log('❌ Test 6 Failed: Tenant A inserted data into Tenant B context!');
  } catch (err: any) {
    if (err.message.includes('new row violates row-level security')) {
        console.log('✅ Test 6 Passed: RLS blocked Tenant A from forging Tenant B inserts.');
    } else {
        console.log('❌ Test 6 Failed with wrong error:', err.message);
    }
  }

  console.log('🎉 RLS Simulation Complete!');
  process.exit(0);
}

runTests();
