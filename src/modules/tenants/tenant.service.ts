import bcrypt from 'bcrypt';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { roles } from '../../db/schema/roles';
import { users } from '../../db/schema/users';
import { TenantRepository } from './tenant.repository';
import { CreateTenantDto } from './tenant.types';
import { withTenant } from '../../middleware/tenant.middleware';
import { AuthService } from '../auth/auth.service';

export class TenantService {
  static async onboardTenant(data: CreateTenantDto) {
    // Check if slug exists
    const existing = await TenantRepository.findBySlug(data.slug);
    if (existing) {
      throw new Error('Workspace slug is already taken');
    }

    // Hash password before transaction to save DB connection time
    const passwordHash = await bcrypt.hash(data.password, 10);

    // Run entire onboarding in a single transaction
    return await db.transaction(async (tx) => {
      // 1. Create the tenant (Global operation, bypasses RLS)
      const tenant = await TenantRepository.createTenant(tx, {
        name: data.companyName,
        slug: data.slug,
      });

      // Now we have the tenant.id. We MUST use withTenant to safely execute the rest.
      // Wait, withTenant uses db.transaction. We are already inside a transaction!
      // But we need to set the local context for this transaction.
      // We can just execute the SET LOCAL directly on this tx!
      
      await tx.execute(`SELECT set_config('app.current_tenant_id', '${tenant.id}', true)`);

      // 2. Create Roles
      const [adminRole] = await tx.insert(roles).values({
        tenantId: tenant.id,
        name: 'Tenant Admin',
        permissions: { "project.create": true, "task.create": true, "user.invite": true, "admin": true }
      }).returning();

      await tx.insert(roles).values([
        {
          tenantId: tenant.id,
          name: 'Project Manager',
          permissions: {
            "project.create": true,
            "project.read": true,
            "project.manage": true,
            "task.create": true,
            "task.read": true,
            "task.update": true
          }
        },
        { tenantId: tenant.id, name: 'Scrum Master', permissions: { "project.read": true, "task.read": true, "task.create": true } },
        { tenantId: tenant.id, name: 'Developer', permissions: { "project.read": true, "task.read": true, "task.create": true, "task.update": true, "comment.create": true } },
        { tenantId: tenant.id, name: 'Viewer', permissions: { "project.read": true, "task.read": true } },
      ]);

      // 3. Create Admin User
      const [ownerUser] = await tx.insert(users).values({
        tenantId: tenant.id,
        roleId: adminRole.id,
        email: data.email,
        passwordHash,
        firstName: data.ownerName.split(' ')[0] || data.ownerName,
        lastName: data.ownerName.split(' ').slice(1).join(' ') || '',
        twoFaEnabled: false
      }).returning();

      // 4. Issue Tokens
      const accessToken = AuthService.generateAccessToken(ownerUser, adminRole);
      const refreshToken = await AuthService.generateRefreshToken(tx, ownerUser);

      return {
        tenant,
        user: {
          id: ownerUser.id,
          email: ownerUser.email,
          firstName: ownerUser.firstName,
          lastName: ownerUser.lastName,
          role: adminRole.name,
          permissions: adminRole.permissions
        },
        accessToken,
        refreshToken
      };
    });
  }
}
