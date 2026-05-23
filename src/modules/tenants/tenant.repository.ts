import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';

export class TenantRepository {
  // Global query (bypasses RLS because tenants are global)
  static async findBySlug(slug: string) {
    const records = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    return records[0];
  }

  // Uses tx for atomic operation
  static async createTenant(tx: any, data: { name: string; slug: string }) {
    const [tenant] = await tx.insert(tenants).values({
      name: data.name,
      slug: data.slug,
      plan: 'starter',
      isActive: true
    }).returning();
    return tenant;
  }
}
