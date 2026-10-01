import { eq } from 'drizzle-orm';
import { roles } from '../../db/schema/roles';
import { withTenant } from '../../middleware/tenant.middleware';

/** A role's current permissions from the database (the access token's copy can be stale) */
export async function roleAccess(tenantId: string, roleId: string): Promise<{ admin: boolean; permissions: Record<string, boolean> }> {
  const [role] = await withTenant<{ name: string; permissions: Record<string, boolean> }[]>(tenantId, (tx) =>
    tx.select({ name: roles.name, permissions: roles.permissions }).from(roles).where(eq(roles.id, roleId)).limit(1),
  );
  const permissions = role?.permissions ?? {};
  return { admin: role?.name === 'Admin' || permissions.admin === true, permissions };
}

export const allows = (access: { admin: boolean; permissions: Record<string, boolean> }, permission: string) =>
  access.admin || access.permissions[permission] === true;
