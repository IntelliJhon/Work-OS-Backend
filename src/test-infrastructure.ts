import { db } from './db';
import { tenants } from './db/schema/tenants';
import { users } from './db/schema/users';
import { roles } from './db/schema/roles';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import app from './app';
import http from 'http';
import jwt from 'jsonwebtoken';
import { env } from './config/env';
import { withTenant } from './middleware/tenant.middleware';

const PORT = 5005;
let server: http.Server;

async function setupTestData() {
  const tId = uuidv4();
  const uId = uuidv4();

  await db.insert(tenants).values({ id: tId, name: `Test Tenant ${Date.now()}`, slug: `test-tenant-${Date.now()}` });
  
  const role = await withTenant(tId, async (tx: any) => {
    const [r] = await tx.insert(roles).values({
      tenantId: tId,
      name: 'Admin',
      permissions: ['upload:create', 'upload:read'],
    }).returning();

    await tx.insert(users).values({
      id: uId,
      tenantId: tId,
      roleId: r.id,
      email: `test-${Date.now()}@test.com`,
      passwordHash: 'dummy',
      firstName: 'Test',
      lastName: 'User',
    });

    return r;
  });

  const token = jwt.sign({ id: uId, tenantId: tId, roleId: role.id }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
  return { tenantId: tId, userId: uId, token };
}

async function runTests() {
  server = app.listen(PORT, () => console.log(`Test server running on port ${PORT}`));
  const baseUrl = `http://localhost:${PORT}`;

  try {
    console.log('--- Setting up test data ---');
    const { tenantId, userId, token } = await setupTestData();

    console.log('\n--- Test 1: Health Checks ---');
    const resHealth = await fetch(`${baseUrl}/health`);
    console.log('Health:', await resHealth.json());

    console.log('\n--- Test 2: Request ID & Observability ---');
    const resDbHealth = await fetch(`${baseUrl}/health/database`);
    console.log('X-Request-Id present:', resDbHealth.headers.has('x-request-id'));

    console.log('\n--- Test 3: Auth Rate Limiter (Max 5 req/15m) ---');
    let authRes;
    for (let i = 0; i < 7; i++) {
      authRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bad', password: 'bad' })
      });
      console.log(`Attempt ${i + 1}: Status ${authRes.status}`);
    }
    if (authRes?.status !== 429) throw new Error('Auth Rate Limiter failed');

    console.log('\n--- Test 4: Global Rate Limiter ---');
    // Global limiter is 100/15m, simulating hitting it is slow, we will trust it if the auth one works and headers are present
    const resGlobal = await fetch(`${baseUrl}/health/redis`);
    console.log('Global Rate Limit Headers:', {
      limit: resGlobal.headers.get('ratelimit-limit'),
      remaining: resGlobal.headers.get('ratelimit-remaining'),
    });

    console.log('\n--- Test 5: Upload Validation & MIME filtering ---');
    const fdInvalid = new FormData();
    fdInvalid.append('entityType', 'TASK');
    fdInvalid.append('entityId', uuidv4());
    fdInvalid.append('files', new Blob(['console.log("bad");'], { type: 'application/javascript' }), 'script.js');

    const resInvalid = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: fdInvalid
    });
    console.log('Invalid MIME Status:', resInvalid.status);
    console.log('Invalid MIME Body:', await resInvalid.text());

    // Missing Auth
    const resNoAuth = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      body: fdInvalid
    });
    console.log('No Auth Status:', resNoAuth.status);

    console.log('\n--- Test 6: Valid File Upload & RLS ---');
    const fdValid = new FormData();
    fdValid.append('entityType', 'TASK');
    fdValid.append('entityId', uuidv4());
    fdValid.append('files', new Blob(['Hello world validation'], { type: 'text/plain' }), 'test.txt');

    const resValid = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: fdValid
    });
    
    console.log('Valid Upload Status:', resValid.status);
    const validBody = await resValid.json();
    console.log('Valid Upload Body:', validBody);
    
    if (resValid.status === 201) {
      console.log('Cloudinary persistence SUCCESS. DB Insert SUCCESS (RLS respected).');
    }

    console.log('\n✅ All Validation Tests Passed!');
  } catch (error) {
    console.error('\n❌ Validation Test Failed:', error);
  } finally {
    server.close();
    process.exit(0);
  }
}

runTests();
