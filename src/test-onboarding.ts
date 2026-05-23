import { TenantService } from './modules/tenants/tenant.service';

async function run() {
  try {
    console.log('🧪 Starting Onboarding...');
    const result = await TenantService.onboardTenant({
      companyName: 'Acme Corp',
      slug: `acme-${Date.now()}`,
      ownerName: 'Akash Doe',
      email: `akash${Date.now()}@gmail.com`,
      password: 'StrongPassword123'
    });
    
    console.log('✅ Onboarding Successful!');
    console.log('Tenant:', result.tenant);
    console.log('Admin User:', result.user);
    console.log('Access Token:', result.accessToken ? 'Generated' : 'Failed');
    console.log('Refresh Token:', result.refreshToken ? 'Generated' : 'Failed');
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Onboarding Failed:', err.message);
    process.exit(1);
  }
}

run();
