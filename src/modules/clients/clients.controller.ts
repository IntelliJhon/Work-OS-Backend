import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { db } from '../../db';
import { tenants } from '../../db/schema/tenants';
import { clientNotes } from '../../db/schema/client_notes';
import { clientOnboarding } from '../../db/schema/client_onboarding';
import { clientDocuments } from '../../db/schema/client_documents';
import { eq, and, desc } from 'drizzle-orm';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { v2 as cloudinary } from 'cloudinary';
import { uploadStream } from '../uploads/cloudinary';

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

      // Retrieve all client documents for this tenant from PostgreSQL
      const existingDocs = await db.select().from(clientDocuments).where(eq(clientDocuments.tenantId, tenant.id)).orderBy(desc(clientDocuments.createdAt));
      const docsMap = new Map<string, any[]>();
      existingDocs.forEach(d => {
        const arr = docsMap.get(d.clientId) || [];
        arr.push(d);
        docsMap.set(d.clientId, arr);
      });

      // Enrich users with comments & documents
      const enrichedUsers = allUsers.map(u => {
        const note = notesMap.get(u.id);
        const docs = docsMap.get(u.id) || [];
        return {
          ...u,
          comment: note?.comment || '',
          commentAuthor: note?.authorName || null,
          commentUpdatedAt: note?.updatedAt ? note.updatedAt.toISOString() : null,
          documents: docs,
          documentsCount: docs.length,
        };
      });

      logger.info({ msg: 'Successfully fetched all external clients and attached comments and documents', totalFetched: enrichedUsers.length });

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
      const clientId = String(req.params.id);
      const { comment } = req.body;

      if (!tenantId || !clientId) {
        return res.status(400).json({ error: 'Missing tenant or client id' });
      }

      const authorName = (req.user as any)?.email || (req.user as any)?.firstName || 'Team Member';

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

  // --- Document Management Endpoints ---

  static async getClientDocuments(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const clientId = String(req.params.id);

      if (!tenantId || !clientId) {
        return res.status(400).json({ error: 'Missing tenant or client id' });
      }

      const docs = await db
        .select()
        .from(clientDocuments)
        .where(and(eq(clientDocuments.tenantId, tenantId), eq(clientDocuments.clientId, clientId)))
        .orderBy(desc(clientDocuments.createdAt));

      return res.json({
        success: true,
        data: docs,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.getClientDocuments error', error: err.message });
      return res.status(500).json({ error: 'Failed to retrieve client documents' });
    }
  }

  static async addClientDocuments(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const clientId = String(req.params.id);

      if (!tenantId || !clientId) {
        return res.status(400).json({ error: 'Missing tenant or client id' });
      }

      const uploaderName = (req.user as any)?.email || (req.user as any)?.firstName || 'Team Member';
      const createdDocs: any[] = [];

      // 1. Check if multipart files were uploaded via multer
      const files = req.files as Express.Multer.File[] | undefined;
      if (files && Array.isArray(files) && files.length > 0) {
        for (const file of files) {
          let fileUrl = '';
          try {
            if (env.CLOUDINARY_URL) {
              const uploadRes = await uploadStream(file.buffer, `clients/${clientId}`, file.originalname);
              fileUrl = uploadRes.secure_url || uploadRes.url;
            }
          } catch (cloudErr: any) {
            logger.warn({ msg: 'Cloudinary upload fallback to inline data', error: cloudErr.message });
          }

          if (!fileUrl) {
            fileUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
          }

          const docName = (req.body?.name && files.length === 1) ? req.body.name : file.originalname;

          const [doc] = await db
            .insert(clientDocuments)
            .values({
              tenantId,
              clientId,
              name: docName,
              fileName: file.originalname,
              fileUrl,
              fileType: file.mimetype,
              fileSize: file.size,
              uploaderName,
            })
            .returning();

          createdDocs.push(doc);
        }
      } else if (req.body) {
        // 2. Direct JSON payload (e.g. array of documents or single document object/URL)
        const incomingDocs = Array.isArray(req.body.documents)
          ? req.body.documents
          : [req.body];

        for (const docData of incomingDocs) {
          if (!docData.name && !docData.fileName) continue;

          const [doc] = await db
            .insert(clientDocuments)
            .values({
              tenantId,
              clientId,
              name: docData.name || docData.fileName || 'Untitled Document',
              fileName: docData.fileName || docData.name || 'document',
              fileUrl: docData.fileUrl || '',
              fileType: docData.fileType || 'application/pdf',
              fileSize: Number(docData.fileSize) || 0,
              uploaderName,
            })
            .returning();

          createdDocs.push(doc);
        }
      }

      return res.status(201).json({
        success: true,
        message: 'Documents attached successfully',
        data: createdDocs,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.addClientDocuments error', error: err.message });
      return res.status(500).json({ error: 'Failed to upload client documents' });
    }
  }

  static async viewClientDocument(req: any, res: Response, next: NextFunction) {
    try {
      const clientId = String(req.params.id);
      const docId = String(req.params.docId);

      const [doc] = await db
        .select()
        .from(clientDocuments)
        .where(and(eq(clientDocuments.id, docId), eq(clientDocuments.clientId, clientId)))
        .limit(1);

      if (!doc) {
        return res.status(404).send('Document not found');
      }

      if (doc.fileUrl.startsWith('data:')) {
        const matches = doc.fileUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          const mime = matches[1];
          const buffer = Buffer.from(matches[2], 'base64');
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.fileName)}"`);
          return res.send(buffer);
        }
      }

      if (doc.fileUrl.includes('cloudinary.com')) {
        const match = doc.fileUrl.match(/(?:upload\/(?:v\d+\/)?)(.+?)(?:\.[^.]+)?$/);
        if (match && env.CLOUDINARY_URL) {
          const publicId = match[1].replace(/\.[^.]+$/, '');
          const isRaw = !doc.fileType?.startsWith('image/') && doc.fileType !== 'application/pdf';
          const resourceType = isRaw ? 'raw' : 'image';
          const ext = doc.fileName.split('.').pop()?.toLowerCase() || 'pdf';

          const signedUrl = cloudinary.utils.private_download_url(publicId, ext, {
            resource_type: resourceType,
            type: 'upload',
            attachment: false,
          });

          return res.redirect(signedUrl);
        }
      }

      return res.redirect(doc.fileUrl);
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.viewClientDocument error', error: err.message });
      return res.status(500).send('Failed to load document');
    }
  }

  static async downloadClientDocument(req: any, res: Response, next: NextFunction) {
    try {
      const clientId = String(req.params.id);
      const docId = String(req.params.docId);

      const [doc] = await db
        .select()
        .from(clientDocuments)
        .where(and(eq(clientDocuments.id, docId), eq(clientDocuments.clientId, clientId)))
        .limit(1);

      if (!doc) {
        return res.status(404).send('Document not found');
      }

      if (doc.fileUrl.startsWith('data:')) {
        const matches = doc.fileUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          const mime = matches[1];
          const buffer = Buffer.from(matches[2], 'base64');
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`);
          return res.send(buffer);
        }
      }

      if (doc.fileUrl.includes('cloudinary.com')) {
        const match = doc.fileUrl.match(/(?:upload\/(?:v\d+\/)?)(.+?)(?:\.[^.]+)?$/);
        if (match && env.CLOUDINARY_URL) {
          const publicId = match[1].replace(/\.[^.]+$/, '');
          const isRaw = !doc.fileType?.startsWith('image/') && doc.fileType !== 'application/pdf';
          const resourceType = isRaw ? 'raw' : 'image';
          const ext = doc.fileName.split('.').pop()?.toLowerCase() || 'pdf';

          const signedUrl = cloudinary.utils.private_download_url(publicId, ext, {
            resource_type: resourceType,
            type: 'upload',
            attachment: true,
          });

          return res.redirect(signedUrl);
        }
      }

      return res.redirect(doc.fileUrl);
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.downloadClientDocument error', error: err.message });
      return res.status(500).send('Failed to download document');
    }
  }

  static async deleteClientDocument(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const docId = String(req.params.docId);

      if (!tenantId || !docId) {
        return res.status(400).json({ error: 'Missing tenant or document id' });
      }

      await db
        .delete(clientDocuments)
        .where(and(eq(clientDocuments.id, docId), eq(clientDocuments.tenantId, tenantId)));

      return res.json({
        success: true,
        message: 'Document deleted successfully',
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.deleteClientDocument error', error: err.message });
      return res.status(500).json({ error: 'Failed to delete client document' });
    }
  }

  // --- Onboarding Pipeline Endpoints ---

  static async getOnboardingClients(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return res.status(400).json({ error: 'Missing tenant context' });
      }

      const list = await db
        .select()
        .from(clientOnboarding)
        .where(eq(clientOnboarding.tenantId, tenantId))
        .orderBy(desc(clientOnboarding.createdAt));

      // Also attach documents to onboarding clients
      const existingDocs = await db.select().from(clientDocuments).where(eq(clientDocuments.tenantId, tenantId)).orderBy(desc(clientDocuments.createdAt));
      const docsMap = new Map<string, any[]>();
      existingDocs.forEach(d => {
        const arr = docsMap.get(d.clientId) || [];
        arr.push(d);
        docsMap.set(d.clientId, arr);
      });

      const enrichedList = list.map(c => {
        const docs = docsMap.get(c.id) || [];
        return {
          ...c,
          documents: docs,
          documentsCount: docs.length,
        };
      });

      return res.json({
        success: true,
        data: enrichedList,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.getOnboardingClients error', error: err.message });
      return res.status(500).json({ error: 'Failed to retrieve onboarding clients' });
    }
  }

  static async createOnboardingClient(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return res.status(400).json({ error: 'Missing tenant context' });
      }

      const {
        clientName,
        contactPerson,
        email,
        phone,
        country,
        stage,
        status,
        assignedTo,
        targetDate,
        notes,
      } = req.body;

      if (!clientName || !clientName.trim()) {
        return res.status(400).json({ error: 'Client name is required' });
      }

      const createdBy = (req.user as any)?.email || (req.user as any)?.firstName || 'Team Member';

      const [newClient] = await db
        .insert(clientOnboarding)
        .values({
          tenantId,
          clientName: clientName.trim(),
          contactPerson: contactPerson?.trim() || null,
          email: email?.trim() || null,
          phone: phone?.trim() || null,
          country: country?.trim() || 'IN',
          stage: stage || 'initiation',
          status: status || 'in_progress',
          assignedTo: assignedTo?.trim() || null,
          targetDate: targetDate?.trim() || null,
          notes: notes?.trim() || null,
          createdBy,
        })
        .returning();

      return res.status(201).json({
        success: true,
        data: newClient,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.createOnboardingClient error', error: err.message });
      return res.status(500).json({ error: 'Failed to create onboarding client' });
    }
  }

  static async updateOnboardingClient(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const id = String(req.params.id);

      if (!tenantId || !id) {
        return res.status(400).json({ error: 'Missing tenant or client id' });
      }

      const {
        clientName,
        contactPerson,
        email,
        phone,
        country,
        stage,
        status,
        assignedTo,
        targetDate,
        notes,
      } = req.body;

      const [updated] = await db
        .update(clientOnboarding)
        .set({
          ...(clientName !== undefined && { clientName: clientName.trim() }),
          ...(contactPerson !== undefined && { contactPerson: contactPerson ? contactPerson.trim() : null }),
          ...(email !== undefined && { email: email ? email.trim() : null }),
          ...(phone !== undefined && { phone: phone.trim() }),
          ...(country !== undefined && { country: country.trim() }),
          ...(stage !== undefined && { stage }),
          ...(status !== undefined && { status }),
          ...(assignedTo !== undefined && { assignedTo: assignedTo.trim() }),
          ...(targetDate !== undefined && { targetDate: targetDate.trim() }),
          ...(notes !== undefined && { notes: notes.trim() }),
          updatedAt: new Date(),
        })
        .where(and(eq(clientOnboarding.id, id), eq(clientOnboarding.tenantId, tenantId)))
        .returning();

      if (!updated) {
        return res.status(404).json({ error: 'Onboarding client not found' });
      }

      return res.json({
        success: true,
        data: updated,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.updateOnboardingClient error', error: err.message });
      return res.status(500).json({ error: 'Failed to update onboarding client' });
    }
  }

  static async deleteOnboardingClient(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const id = String(req.params.id);

      if (!tenantId || !id) {
        return res.status(400).json({ error: 'Missing tenant or client id' });
      }

      await db
        .delete(clientOnboarding)
        .where(and(eq(clientOnboarding.id, id), eq(clientOnboarding.tenantId, tenantId)));

      return res.json({
        success: true,
        message: 'Onboarding client deleted successfully',
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientsController.deleteOnboardingClient error', error: err.message });
      return res.status(500).json({ error: 'Failed to delete onboarding client' });
    }
  }
}
