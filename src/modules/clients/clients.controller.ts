import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { clientNotes } from '../../db/schema/client_notes';
import { eq, and } from 'drizzle-orm';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

export class ClientsController {
  static async getClients(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return res.status(400).json({ error: 'Missing tenant context in session' });
      }

      // Query database for current user's tenant
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const tenantSlug = tenant.slug?.toLowerCase() || '';

      // Multi-tenant Company Isolation Enforcement:
      // The Clients section is specifically intended for our company (leadsndeals).
      const LEADSNDEALS_TENANT_ID = 'aee1faf8-27d5-4f5d-9b14-9246abbd0eec';

      const isOurCompany =
        tenantId === LEADSNDEALS_TENANT_ID ||
        tenantId === 'leadsndeals' ||
        tenant.id === LEADSNDEALS_TENANT_ID ||
        tenantSlug === 'leadsndeals' ||
        tenantSlug.includes('leadsndeals') ||
        tenantSlug.includes('leadsndelas') ||
        tenant.name.toLowerCase().includes('leadsndeals');

      if (!isOurCompany) {
        logger.info({ msg: 'Clients access isolated for tenant', tenantId, slug: tenant.slug });
        return res.json({
          success: true,
          company: tenant.name,
          slug: tenant.slug,
          isOurCompany: false,
          users: [],
          totalCount: 0,
        });
      }

      // Fetch all client users across paginated pages from external API
      const apiBase = env.AUTOMATIONS_BUILDER_API_BASE || 'https://partner-api.automationsbuilder.com';
      const apiToken = env.AUTOMATIONS_BUILDER_API_TOKEN;

      const limit = 20;
      let page = 1;
      let hasMore = true;
      const allUsers: any[] = [];

      logger.info({ msg: 'Fetching paginated external users for leadsndeals', tenantId, apiBase });

      while (hasMore && page <= 25) {
        const externalUrl = `${apiBase}/api/v1/users?page=${page}&limit=${limit}`;

        const apiRes = await fetch(externalUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Accept': 'application/json',
            'User-Agent': 'WorkOS-Server/1.0',
          },
        });

        if (!apiRes.ok) {
          logger.error({ msg: 'External API HTTP error during pagination', status: apiRes.status, page });
          if (page === 1) {
            return res.status(apiRes.status).json({
              error: `External Partner API responded with status ${apiRes.status}`,
            });
          }
          break;
        }

        const json: any = await apiRes.json();
        const batch = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);

        if (batch.length === 0) {
          hasMore = false;
        } else {
          allUsers.push(...batch);
          if (batch.length < limit) {
            hasMore = false;
          } else {
            page++;
          }
        }
      }

      // Retrieve all internal comments / updates for this tenant from PostgreSQL
      const existingNotes = await db.select().from(clientNotes).where(eq(clientNotes.tenantId, tenant.id));
      const notesMap = new Map<string, { comment: string; authorName?: string | null; updatedAt?: Date }>();
      existingNotes.forEach(n => {
        notesMap.set(n.clientId, {
          comment: n.comment,
          authorName: n.authorName,
          updatedAt: n.updatedAt,
        });
      });

      // Enrich users with comments
      const enrichedUsers = allUsers.map(u => {
        const note = notesMap.get(u.id);
        return {
          ...u,
          comment: note?.comment || '',
          commentAuthor: note?.authorName || null,
          commentUpdatedAt: note?.updatedAt ? note.updatedAt.toISOString() : null,
        };
      });

      logger.info({ msg: 'Successfully fetched all external clients and attached comments', totalFetched: enrichedUsers.length });

      return res.json({
        success: true,
        company: tenant.name,
        slug: tenant.slug,
        isOurCompany: true,
        totalCount: enrichedUsers.length,
        users: enrichedUsers,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.getClients error', error: err.message });
      return res.status(500).json({ error: 'Failed to retrieve clients list' });
    }
  }

  static async saveClientComment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const clientId = req.params.id;
      const { comment } = req.body;

      if (!tenantId || !clientId) {
        return res.status(400).json({ error: 'Missing tenant or client id' });
      }

      const authorName = req.user?.email || 'Team Member';

      // Check if note exists
      const existing = await db
        .select()
        .from(clientNotes)
        .where(and(eq(clientNotes.tenantId, tenantId), eq(clientNotes.clientId, clientId)))
        .limit(1);

      if (existing.length > 0) {
        const [updated] = await db
          .update(clientNotes)
          .set({
            comment: comment || '',
            authorName,
            updatedAt: new Date(),
          })
          .where(eq(clientNotes.id, existing[0].id))
          .returning();
        return res.json({ success: true, note: updated });
      } else {
        const [created] = await db
          .insert(clientNotes)
          .values({
            tenantId,
            clientId,
            comment: comment || '',
            authorName,
          })
          .returning();
        return res.json({ success: true, note: created });
      }
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.saveClientComment error', error: err.message });
      return res.status(500).json({ error: 'Failed to save comment' });
    }
  }
}
