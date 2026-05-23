import { db } from './src/db/index';
import { tenants } from './src/db/schema/tenants';
import { users } from './src/db/schema/users';
import { roles } from './src/db/schema/roles';
import { projects } from './src/db/schema/projects';
import { phases } from './src/db/schema/phases';
import { sprints } from './src/db/schema/sprints';
import { qualityGates } from './src/db/schema/quality_gates';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import app from './src/app';
import http from 'http';
import jwt from 'jsonwebtoken';
import { env } from './src/config/env';
import { withTenant } from './src/middleware/tenant.middleware';

const PORT = 5006;
let server: http.Server;

async function setupTestData() {
  const tId = uuidv4();
  const uId = uuidv4();

  // Create tenant
  const [tenant] = await db.insert(tenants).values({ id: tId, name: `Workflow Tenant ${Date.now()}`, slug: `workflow-tenant-${Date.now()}` }).returning();
  
  const role = await withTenant(tId, async (tx: any) => {
    // Create role with project.manage permission
    const [r] = await tx.insert(roles).values({
      tenantId: tId,
      name: 'Project Manager',
      permissions: {
        'project.manage': true,
        'project.read': true,
        'project.create': true,
        'task.read': true,
        'task.create': true,
        'task.update': true
      },
    }).returning();

    // Create user
    await tx.insert(users).values({
      id: uId,
      tenantId: tId,
      roleId: r.id,
      email: `pm-${Date.now()}@test.com`,
      passwordHash: 'dummy',
      firstName: 'PM',
      lastName: 'User',
    });

    return r;
  });

  const token = jwt.sign({ id: uId, tenantId: tId, roleId: role.id, permissions: role.permissions }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
  return { tenantId: tId, userId: uId, token };
}

async function runTests() {
  server = app.listen(PORT, () => console.log(`Workflow Test server running on port ${PORT}`));
  const baseUrl = `http://localhost:${PORT}`;

  try {
    console.log('--- Setting up test tenant and user ---');
    const { tenantId, userId, token } = await setupTestData();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    let projectId: string;
    let phase1Id: string;
    let phase2Id: string;
    let sprintId: string;
    let gate1Id: string;

    await withTenant(tenantId, async (tx) => {
      // 1. Create a Project
      const [proj] = await tx.insert(projects).values({
        tenantId,
        name: 'Workflow Test Project',
      }).returning();
      projectId = proj.id;

      // 2. Create Phase 1 (active) and Phase 2 (pending)
      const [p1] = await tx.insert(phases).values({
        tenantId,
        projectId: proj.id,
        name: 'Phase 1: Foundation',
        orderIndex: 1,
        status: 'active',
        isLocked: false
      }).returning();
      phase1Id = p1.id;

      const [p2] = await tx.insert(phases).values({
        tenantId,
        projectId: proj.id,
        name: 'Phase 2: Execution',
        orderIndex: 2,
        status: 'pending',
        isLocked: true // Locked until Phase 1 completed & gate approved
      }).returning();
      phase2Id = p2.id;

      // 3. Create active Sprint inside Phase 1
      const [sp] = await tx.insert(sprints).values({
        tenantId,
        projectId: proj.id,
        phaseId: p1.id,
        name: 'Sprint 1',
        status: 'active'
      }).returning();
      sprintId = sp.id;

      // 4. Create quality gate for Phase 1
      const [gate] = await tx.insert(qualityGates).values({
        tenantId,
        projectId: proj.id,
        phaseId: p1.id,
        criteria: {},
        status: 'pending'
      }).returning();
      gate1Id = gate.id;
    });

    console.log(`Setup complete. Project: ${projectId!}, Phase1: ${phase1Id!}, Phase2: ${phase2Id!}, Sprint: ${sprintId!}, Gate: ${gate1Id!}`);

    // --- TEST 1: Close Sprint ---
    console.log('\n--- TEST 1: Closing Sprint (Expected 200) ---');
    const resCloseSprint = await fetch(`${baseUrl}/api/sprints/${sprintId!}/close`, {
      method: 'POST',
      headers
    });
    console.log('Close Sprint Status:', resCloseSprint.status);
    console.log('Close Sprint Body:', await resCloseSprint.text());

    // --- TEST 2: Approve Gate ---
    console.log('\n--- TEST 2: Approving Gate (Expected 200, which should complete Phase 1 and unlock Phase 2) ---');
    const resApproveGate = await fetch(`${baseUrl}/api/gates/${gate1Id!}/approve`, {
      method: 'POST',
      headers
    });
    console.log('Approve Gate Status:', resApproveGate.status);
    console.log('Approve Gate Body:', await resApproveGate.text());

    // --- TEST 3: Activate Phase 2 ---
    console.log('\n--- TEST 3: Activating Phase 2 (Expected 200) ---');
    const resActivatePhase = await fetch(`${baseUrl}/api/phases/${phase2Id!}/activate`, {
      method: 'POST',
      headers
    });
    console.log('Activate Phase Status:', resActivatePhase.status);
    console.log('Activate Phase Body:', await resActivatePhase.text());

  } catch (error) {
    console.error('\n❌ Workflow API Test Failed:', error);
  } finally {
    server.close();
    process.exit(0);
  }
}

runTests();
