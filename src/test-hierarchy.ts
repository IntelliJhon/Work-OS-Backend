import { db } from './db';
import { tenants } from './db/schema/tenants';
import { users } from './db/schema/users';
import { roles } from './db/schema/roles';
import { projects } from './db/schema/projects';
import { phases } from './db/schema/phases';
import { sprints } from './db/schema/sprints';
import { epics } from './db/schema/epics';
import { stories } from './db/schema/stories';
import { eq } from 'drizzle-orm';
import { withTenant } from './middleware/tenant.middleware';
import dotenv from 'dotenv';
dotenv.config();

async function runHierarchyTest() {
  console.log('--- Starting Hierarchy Creation & RLS Verification ---');

  // Fetch a tenant and an admin user to act as context
  const [tenant] = await db.select().from(tenants).limit(1);
  if (!tenant) {
    console.log('No tenants found. Run onboarding tests first.');
    return;
  }

  let adminUser;
  await withTenant(tenant.id, async (tx) => {
    let [foundUser] = await tx.select().from(users).where(eq(users.tenantId, tenant.id)).limit(1);
    if (!foundUser) {
      console.log('No user found, creating one...');
      const [role] = await tx.insert(roles).values({ tenantId: tenant.id, name: 'Admin', permissions: {} }).returning();
      [foundUser] = await tx.insert(users).values({
        tenantId: tenant.id,
        email: 'testadmin@example.com',
        firstName: 'Test',
        lastName: 'Admin',
        passwordHash: 'dummy',
        roleId: role.id
      }).returning();
    }
    adminUser = foundUser;
  });

  console.log(`Using Tenant: ${tenant.name} (${tenant.id})`);
  console.log(`Using User: ${adminUser!.email}`);

  try {
    await withTenant(tenant.id, async (tx) => {
      // 1. Create a Project
      console.log('\n[1/5] Creating Project...');
      const [newProject] = await tx.insert(projects).values({
        tenantId: tenant.id,
        name: 'WorkOS Development',
        description: 'Building the core modules',
      }).returning();
      console.log(`Project Created: ${newProject.name} (${newProject.id})`);

      // 2. Create a Phase
      console.log('\n[2/5] Creating Phase...');
      const [newPhase] = await tx.insert(phases).values({
        tenantId: tenant.id,
        projectId: newProject.id,
        name: 'Phase 2: CRUD Modules',
        orderIndex: 2,
        status: 'active'
      }).returning();
      console.log(`Phase Created: ${newPhase.name} (${newPhase.id})`);

      // 3. Create a Sprint
      console.log('\n[3/5] Creating Sprint...');
      const [newSprint] = await tx.insert(sprints).values({
        tenantId: tenant.id,
        projectId: newProject.id,
        phaseId: newPhase.id,
        name: 'Sprint 5: API Endpoints',
        status: 'active'
      }).returning();
      console.log(`Sprint Created: ${newSprint.name} (${newSprint.id})`);

      // 4. Create an Epic
      console.log('\n[4/5] Creating Epic...');
      const [newEpic] = await tx.insert(epics).values({
        tenantId: tenant.id,
        projectId: newProject.id,
        name: 'Hierarchy Management',
      }).returning();
      console.log(`Epic Created: ${newEpic.name} (${newEpic.id})`);

      // 5. Create a Story
      console.log('\n[5/5] Creating Story...');
      const [newStory] = await tx.insert(stories).values({
        tenantId: tenant.id,
        projectId: newProject.id,
        epicId: newEpic.id,
        name: 'As a PM, I can create projects and phases',
      }).returning();
      console.log(`Story Created: ${newStory.name} (${newStory.id})`);

      console.log('\nSUCCESS! All hierarchy levels successfully inserted under RLS.');
    });
  } catch (error) {
    console.error('\nFAILURE during hierarchy creation:', error);
  }
  
  process.exit(0);
}

runHierarchyTest();
