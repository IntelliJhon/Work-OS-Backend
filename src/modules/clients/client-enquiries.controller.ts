import { Response, NextFunction } from 'express';
import { categoryFields } from './client-category';
import { CampaignsService } from '../campaigns/campaigns.service';
import { AuthRequest } from '../../middleware/auth.middleware';
import { db } from '../../db';
import { clientEnquiries } from '../../db/schema/client_enquiries';
import { clientOnboarding } from '../../db/schema/client_onboarding';
import { eq, and, desc } from 'drizzle-orm';
import { logger } from '../../config/logger';

export class ClientEnquiriesController {
  /**
   * List all enquiry clients for active tenant
   */
  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return res.status(400).json({ error: 'Missing tenant context' });
      }

      const data = await db
        .select()
        .from(clientEnquiries)
        .where(eq(clientEnquiries.tenantId, tenantId))
        .orderBy(desc(clientEnquiries.createdAt));

      return res.json({
        success: true,
        data,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientEnquiriesController.list error', error: err.message });
      return res.status(500).json({ error: 'Failed to retrieve enquiry clients' });
    }
  }

  /**
   * Create a single enquiry client record
   */
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return res.status(400).json({ error: 'Missing tenant context' });
      }

      const { clientName, number, email, remarks, sourceSheetName } = req.body;

      if (!clientName || !clientName.trim()) {
        return res.status(400).json({ error: 'Client name is required' });
      }
      if (!number || !number.trim()) {
        return res.status(400).json({ error: 'Contact number is required' });
      }

      const createdBy = (req.user as any)?.email || req.user?.id || 'HR';

      const [newEntry] = await db
        .insert(clientEnquiries)
        .values({
          tenantId,
          clientName: clientName.trim(),
          number: number.trim(),
          email: email?.trim() || null,
          remarks: remarks?.trim() || null,
          sourceSheetName: sourceSheetName?.trim() || null,
          ...categoryFields(req.body ?? {}),
          createdBy,
        })
        .returning();

      CampaignsService.enrolQuietly(tenantId, { kind: 'enquiry', refId: newEntry.id, phone: newEntry.number, name: newEntry.clientName, category: newEntry.category, subcategory: newEntry.subcategory });
      return res.status(201).json({
        success: true,
        data: newEntry,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientEnquiriesController.create error', error: err.message });
      return res.status(500).json({ error: 'Failed to create enquiry client' });
    }
  }

  /**
   * Bulk import enquiry clients from uploaded/parsed spreadsheet
   */
  static async importBulk(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return res.status(400).json({ error: 'Missing tenant context' });
      }

      const { items, sourceSheetName } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No valid enquiry items provided' });
      }

      const createdBy = (req.user as any)?.email || req.user?.id || 'HR';

      const rowsToInsert = items
        .filter((item: any) => item.clientName && item.clientName.trim() && item.number && item.number.trim())
        .map((item: any) => ({
          tenantId,
          clientName: String(item.clientName).trim(),
          number: String(item.number).trim(),
          email: item.email ? String(item.email).trim() : null,
          remarks: item.remarks ? String(item.remarks).trim() : null,
          sourceSheetName: sourceSheetName?.trim() || item.sourceSheetName || 'Uploaded Sheet',
          ...categoryFields(item ?? {}),
          createdBy,
        }));

      if (rowsToInsert.length === 0) {
        return res.status(400).json({ error: 'No valid client rows with name and number found in sheet data' });
      }

      const inserted = await db
        .insert(clientEnquiries)
        .values(rowsToInsert)
        .returning();

      // One by one in the background (each checks for an existing sequence or opt-out)
      void (async () => {
        for (const e of inserted) {
          await CampaignsService.enrol(tenantId, { kind: 'enquiry', refId: e.id, phone: e.number, name: e.clientName, category: e.category, subcategory: e.subcategory }).catch(() => undefined);
        }
      })();
      return res.status(201).json({
        success: true,
        count: inserted.length,
        data: inserted,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientEnquiriesController.importBulk error', error: err.message });
      return res.status(500).json({ error: 'Failed to import enquiry clients' });
    }
  }

  /**
   * Update an existing enquiry client
   */
  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const id = String(req.params.id);

      if (!tenantId || !id) {
        return res.status(400).json({ error: 'Missing tenant or enquiry ID' });
      }

      const { clientName, number, email, remarks } = req.body;

      const [updated] = await db
        .update(clientEnquiries)
        .set({
          ...(clientName !== undefined && { clientName: clientName.trim() }),
          ...(number !== undefined && { number: number.trim() }),
          ...(email !== undefined && { email: email?.trim() || null }),
          ...(remarks !== undefined && { remarks: remarks?.trim() || null }),
          ...categoryFields(req.body ?? {}),
          updatedAt: new Date(),
        })
        .where(and(eq(clientEnquiries.id, id), eq(clientEnquiries.tenantId, tenantId)))
        .returning();

      if (!updated) {
        return res.status(404).json({ error: 'Enquiry client record not found' });
      }

      if (req.body?.category) {
        CampaignsService.enrolQuietly(tenantId, { kind: 'enquiry', refId: updated.id, phone: updated.number, name: updated.clientName, category: updated.category, subcategory: updated.subcategory });
      }
      return res.json({
        success: true,
        data: updated,
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientEnquiriesController.update error', error: err.message });
      return res.status(500).json({ error: 'Failed to update enquiry client' });
    }
  }

  /**
   * Move an enquiry to Onboarding Clients (keeps its id). Its campaign stops on the next round, because the
   * enquiry no longer exists.
   */
  static async moveToOnboarding(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const id = String(req.params.id);
      if (!tenantId || !id) {
        return res.status(400).json({ error: 'Missing tenant or enquiry ID' });
      }

      const moved = await db.transaction(async (tx) => {
        const [e] = await tx.select().from(clientEnquiries)
          .where(and(eq(clientEnquiries.id, id), eq(clientEnquiries.tenantId, tenantId))).limit(1);
        if (!e) return null;
        const [taken] = await tx.select({ id: clientOnboarding.id }).from(clientOnboarding).where(eq(clientOnboarding.id, e.id)).limit(1);
        const [row] = await tx.insert(clientOnboarding).values({
          ...(taken ? {} : { id: e.id }),
          tenantId,
          clientName: e.clientName,
          email: e.email,
          phone: e.number,
          notes: e.remarks,
          category: e.category,
          subcategory: e.subcategory,
          usesSoftware: e.usesSoftware,
          softwareName: e.softwareName,
          createdBy: e.createdBy,
        }).returning();
        await tx.delete(clientEnquiries).where(eq(clientEnquiries.id, e.id));
        return row;
      });

      if (!moved) {
        return res.status(404).json({ error: 'Enquiry client record not found' });
      }
      return res.json({ success: true, data: moved });
    } catch (err: any) {
      logger.error({ msg: 'ClientEnquiriesController.moveToOnboarding error', error: err.message });
      return res.status(500).json({ error: 'Failed to move the enquiry to Onboarding Clients' });
    }
  }

  /**
   * Delete an enquiry client
   */
  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const id = String(req.params.id);

      if (!tenantId || !id) {
        return res.status(400).json({ error: 'Missing tenant or enquiry ID' });
      }

      const deleted = await db
        .delete(clientEnquiries)
        .where(and(eq(clientEnquiries.id, id), eq(clientEnquiries.tenantId, tenantId)))
        .returning();

      if (deleted.length === 0) {
        return res.status(404).json({ error: 'Enquiry client record not found' });
      }

      return res.json({
        success: true,
        message: 'Enquiry client deleted successfully',
      });
    } catch (err: any) {
      logger.error({ msg: 'ClientEnquiriesController.delete error', error: err.message });
      return res.status(500).json({ error: 'Failed to delete enquiry client' });
    }
  }
}
