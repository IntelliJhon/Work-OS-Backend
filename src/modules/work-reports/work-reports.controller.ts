import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { db } from '../../db';
import { workReports } from '../../db/schema/work_reports';
import { clientNotes } from '../../db/schema/client_notes';
import { clientOnboarding } from '../../db/schema/client_onboarding';
import { eq, and, desc } from 'drizzle-orm';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { uploadStream } from '../uploads/cloudinary';

export class WorkReportsController {
  /**
   * List all work reports for a specific employee
   */
  static async listByEmployee(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const employeeId = String(req.params.employeeId);

      if (!tenantId || !employeeId) {
        return res.status(400).json({ error: 'Missing tenant or employee ID' });
      }

      const list = await db
        .select()
        .from(workReports)
        .where(and(eq(workReports.tenantId, tenantId), eq(workReports.employeeId, employeeId)))
        .orderBy(desc(workReports.createdAt));

      return res.json({
        success: true,
        data: list,
      });
    } catch (err: any) {
      logger.error({ msg: 'WorkReportsController.listByEmployee error', error: err.message });
      return res.status(500).json({ error: 'Failed to retrieve work reports' });
    }
  }

  /**
   * Create a new work report for an employee
   */
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return res.status(400).json({ error: 'Missing tenant context' });
      }

      const { employeeId, title, reportText, documentUrl: bodyDocUrl, documentName: bodyDocName } = req.body;

      if (!employeeId || !employeeId.trim()) {
        return res.status(400).json({ error: 'Target employee ID is required' });
      }

      if (!reportText || !reportText.trim()) {
        return res.status(400).json({ error: 'Work report text content is required' });
      }

      // Authorization Check: Only target employee or admin can create report
      const userId = req.user?.id || (req.user as any)?.sub;
      const userEmail = (req.user as any)?.email?.toLowerCase();
      const userRole = (req.user as any)?.role || (req.user as any)?.roleName || '';
      const isUserAdmin =
        userRole.toLowerCase().includes('admin') ||
        userRole.toLowerCase() === 'superadmin' ||
        userRole.toLowerCase() === 'tenant admin';

      const isTargetSelf =
        userId === employeeId.trim() ||
        (userEmail && userEmail === employeeId.trim().toLowerCase());

      if (!isUserAdmin && !isTargetSelf) {
        return res.status(403).json({
          error: 'Permission denied: You can only create work reports for your own profile, unless you are an Admin.',
        });
      }

      const authorId = req.user?.id || (req.user as any)?.sub || 'unknown';
      const authorEmail = (req.user as any)?.email || '';
      const authorFirstName = (req.user as any)?.firstName || '';
      const authorLastName = (req.user as any)?.lastName || '';
      const authorName = `${authorFirstName} ${authorLastName}`.trim() || authorEmail.split('@')[0] || 'Team Member';

      let documentUrl = bodyDocUrl?.trim() || null;
      let documentName = bodyDocName?.trim() || null;
      let fileType: string | null = null;
      let fileSize: string | null = null;

      // Handle optional uploaded file via multer
      const file = (req as any).file as Express.Multer.File | undefined;
      if (file) {
        documentName = file.originalname;
        fileType = file.mimetype;
        fileSize = `${file.size}`;
        try {
          if (env.CLOUDINARY_URL) {
            const uploadRes = await uploadStream(file.buffer, `work_reports/${employeeId}`, file.originalname);
            documentUrl = uploadRes.secure_url || uploadRes.url;
          }
        } catch (cloudErr: any) {
          logger.warn({ msg: 'Cloudinary upload fallback to data URL', error: cloudErr.message });
        }

        if (!documentUrl) {
          documentUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        }
      }

      const [newReport] = await db
        .insert(workReports)
        .values({
          tenantId,
          employeeId: employeeId.trim(),
          authorId,
          authorName,
          authorEmail,
          title: title?.trim() || null,
          reportText: reportText.trim(),
          documentUrl,
          documentName,
          fileType,
          fileSize,
        })
        .returning();

      // Auto-sync remarks to mentioned clients
      await WorkReportsController.syncClientRemarks(tenantId, newReport.id, reportText.trim(), authorName, new Date());

      return res.status(201).json({
        success: true,
        data: newReport,
      });
    } catch (err: any) {
      logger.error({ msg: 'WorkReportsController.create error', error: err.message });
      return res.status(500).json({ error: 'Failed to create work report' });
    }
  }

  /**
   * Update an existing work report
   * ONLY allowed for:
   * 1. The employee who authored the report or target employee (authorId / authorEmail / employeeId match)
   * 2. An Admin user
   */
  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const reportId = String(req.params.id);

      if (!tenantId || !reportId) {
        return res.status(400).json({ error: 'Missing tenant or report ID' });
      }

      // Fetch existing report
      const [report] = await db
        .select()
        .from(workReports)
        .where(and(eq(workReports.id, reportId), eq(workReports.tenantId, tenantId)))
        .limit(1);

      if (!report) {
        return res.status(404).json({ error: 'Work report not found' });
      }

      // Authorization Check
      const userId = req.user?.id || (req.user as any)?.sub;
      const userEmail = (req.user as any)?.email?.toLowerCase();
      const userRole = (req.user as any)?.role || (req.user as any)?.roleName || '';
      const isUserAdmin =
        userRole.toLowerCase().includes('admin') ||
        userRole.toLowerCase() === 'superadmin' ||
        userRole.toLowerCase() === 'tenant admin';

      const isAuthor =
        userId === report.authorId ||
        (userEmail && userEmail === report.authorEmail?.toLowerCase()) ||
        userId === report.employeeId ||
        (userEmail && userEmail === report.employeeId?.toLowerCase());

      if (!isUserAdmin && !isAuthor) {
        return res.status(403).json({
          error: 'Permission denied: You can only edit your own work reports, unless you are an Admin.',
        });
      }

      const { title, reportText, documentUrl: bodyDocUrl, documentName: bodyDocName } = req.body;

      let documentUrl = bodyDocUrl !== undefined ? (bodyDocUrl?.trim() || null) : report.documentUrl;
      let documentName = bodyDocName !== undefined ? (bodyDocName?.trim() || null) : report.documentName;
      let fileType: string | null = report.fileType;
      let fileSize: string | null = report.fileSize;

      // Handle file update if provided via multer
      const file = (req as any).file as Express.Multer.File | undefined;
      if (file) {
        documentName = file.originalname;
        fileType = file.mimetype;
        fileSize = `${file.size}`;
        try {
          if (env.CLOUDINARY_URL) {
            const uploadRes = await uploadStream(file.buffer, `work_reports/${report.employeeId}`, file.originalname);
            documentUrl = uploadRes.secure_url || uploadRes.url;
          }
        } catch (cloudErr: any) {
          logger.warn({ msg: 'Cloudinary upload fallback', error: cloudErr.message });
        }

        if (!documentUrl) {
          documentUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        }
      }

      const [updated] = await db
        .update(workReports)
        .set({
          ...(title !== undefined && { title: title?.trim() || null }),
          ...(reportText !== undefined && { reportText: reportText.trim() }),
          documentUrl,
          documentName,
          fileType,
          fileSize,
          updatedAt: new Date(),
        })
        .where(and(eq(workReports.id, reportId), eq(workReports.tenantId, tenantId)))
        .returning();

      if (reportText !== undefined) {
        const updaterName = (req.user as any)?.firstName ? `${(req.user as any).firstName} ${(req.user as any).lastName || ''}`.trim() : (req.user as any)?.email || 'Team Member';
        await WorkReportsController.syncClientRemarksOnUpdate(
          tenantId,
          reportId,
          report.reportText,
          reportText.trim(),
          updaterName,
          new Date()
        );
      }

      return res.json({
        success: true,
        data: updated,
      });
    } catch (err: any) {
      logger.error({ msg: 'WorkReportsController.update error', error: err.message });
      return res.status(500).json({ error: 'Failed to update work report' });
    }
  }

  /**
   * Delete a work report
   */
  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const reportId = String(req.params.id);

      if (!tenantId || !reportId) {
        return res.status(400).json({ error: 'Missing tenant or report ID' });
      }

      // Fetch existing report
      const [report] = await db
        .select()
        .from(workReports)
        .where(and(eq(workReports.id, reportId), eq(workReports.tenantId, tenantId)))
        .limit(1);

      if (!report) {
        return res.status(404).json({ error: 'Work report not found' });
      }

      // Authorization Check
      const userId = req.user?.id || (req.user as any)?.sub;
      const userEmail = (req.user as any)?.email?.toLowerCase();
      const userRole = (req.user as any)?.role || (req.user as any)?.roleName || '';
      const isUserAdmin =
        userRole.toLowerCase().includes('admin') ||
        userRole.toLowerCase() === 'superadmin' ||
        userRole.toLowerCase() === 'tenant admin';

      const isAuthor =
        userId === report.authorId ||
        (userEmail && userEmail === report.authorEmail?.toLowerCase()) ||
        userId === report.employeeId ||
        (userEmail && userEmail === report.employeeId?.toLowerCase());

      if (!isUserAdmin && !isAuthor) {
        return res.status(403).json({
          error: 'Permission denied: You can only delete your own work reports, unless you are an Admin.',
        });
      }

      await db
        .delete(workReports)
        .where(and(eq(workReports.id, reportId), eq(workReports.tenantId, tenantId)));

      // Auto-remove remarks from mentioned clients
      await WorkReportsController.syncClientRemarksOnDelete(
        tenantId,
        reportId,
        report.reportText
      );

      return res.json({
        success: true,
        message: 'Work report deleted successfully',
      });
    } catch (err: any) {
      logger.error({ msg: 'WorkReportsController.delete error', error: err.message });
      return res.status(500).json({ error: 'Failed to delete work report' });
    }
  }

  /**
   * Helper: Extract pure report content for a specific client from a line.
   * Strips numbering, bullet marks, and leading @Client Name prefix so only the actual update remains.
   */
  static extractClientPoint(line: string, clientName: string): string {
    let cleaned = line.replace(/^\d+[.)]\s*/, '').replace(/^[•\-\*]\s*/, '').trim();
    const escaped = clientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRegex = new RegExp('^(?:@|\\*\\*)?' + escaped + '(?:\\*\\*)?\\s*[-:–—]?\\s*', 'i');
    if (prefixRegex.test(cleaned)) {
      cleaned = cleaned.replace(prefixRegex, '').trim();
    } else {
      const atRegex = new RegExp('@' + escaped, 'gi');
      cleaned = cleaned.replace(atRegex, clientName).trim();
    }
    return cleaned;
  }

  /**
   * Helper: Parse note text into sections separated by double newlines,
   * and remove blocks originating from this reportId or matching oldLines.
   */
  static cleanReportRemarksFromText(
    existingText: string | null | undefined,
    reportId: string,
    oldLines: string[] = []
  ): string {
    if (!existingText) return '';
    const shortId = reportId ? reportId.slice(0, 8) : '';
    const cleanedOldLines = oldLines
      .map((l) => l.replace(/^[\d]+[.)]\s*/, '').replace(/^[•\-\*]\s*/, '').trim())
      .filter((l) => l.length > 0);

    if (cleanedOldLines.length === 0 && !shortId) return existingText.trim();

    const sections = existingText.split(/\n\s*\n/);
    const remainingSections: string[] = [];

    for (const sec of sections) {
      const trimmed = sec.trim();
      if (!trimmed) continue;

      // 1. Match legacy 📌 blocks
      if (trimmed.startsWith('📌')) {
        const hasId = Boolean(shortId && (trimmed.includes(shortId) || trimmed.includes(reportId)));
        const hasOldLine = cleanedOldLines.some((l) => trimmed.includes(l));
        if (hasId || hasOldLine) continue; // remove legacy block
      }

      // 2. Check if the entire section exactly equals one of old lines (with or without bullet)
      const isExactOld = cleanedOldLines.some((l) => {
        const normL = l.toLowerCase();
        const normTrimmed = trimmed.toLowerCase();
        return normTrimmed === normL || normTrimmed === `• ${normL}` || normTrimmed === `- ${normL}`;
      });
      if (isExactOld) continue;

      // 3. If the section contains multiple lines (e.g. bullets), filter out lines that match old lines
      const secLines = sec.split('\n');
      const filteredLines = secLines.filter((line) => {
        const cleanLine = line.replace(/^[\d]+[.)]\s*/, '').replace(/^[•\-\*]\s*/, '').trim().toLowerCase();
        return !cleanedOldLines.some((l) => cleanLine === l.toLowerCase());
      });

      if (filteredLines.length === 0) {
        continue;
      }

      if (filteredLines.length < secLines.length) {
        remainingSections.push(filteredLines.join('\n').trim());
      } else {
        remainingSections.push(trimmed);
      }
    }

    return remainingSections.filter(Boolean).join('\n\n');
  }

  /**
   * Helper: Fetch all Onboarded (Partner API) and Onboarding (DB) clients
   */
  static async fetchAllClients(tenantId: string): Promise<Array<{
    id: string;
    name: string;
    type: 'onboarded' | 'onboarding';
    existingNotes?: string | null;
  }>> {
    const apiBase = env.AUTOMATIONS_BUILDER_API_BASE || 'https://partner-api.automationsbuilder.com';
    const apiToken = env.AUTOMATIONS_BUILDER_API_TOKEN;

    const onboardedList: Array<{ id: string; name: string; type: 'onboarded' }> = [];
    if (apiToken) {
      try {
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= 10) {
          const res = await fetch(`${apiBase}/api/v1/users?page=${page}&limit=${50}`, {
            headers: {
              Authorization: `Bearer ${apiToken}`,
              Accept: 'application/json',
            },
          });
          if (!res.ok) break;
          const json: any = await res.json();
          const batch = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
          if (batch.length === 0) {
            hasMore = false;
          } else {
            for (const u of batch) {
              const firstName = u.profile?.name?.first || '';
              const lastName = u.profile?.name?.last || '';
              const fullName = `${firstName} ${lastName}`.trim() || u.email?.split('@')[0] || '';
              if (fullName) {
                onboardedList.push({ id: u.id, name: fullName, type: 'onboarded' });
              }
            }
            if (batch.length < 50) hasMore = false;
            else page++;
          }
        }
      } catch (err: any) {
        logger.warn({ msg: 'Failed fetching partner API users in fetchAllClients', error: err.message });
      }
    }

    const onboardingListDb = await db
      .select({ id: clientOnboarding.id, clientName: clientOnboarding.clientName, notes: clientOnboarding.notes })
      .from(clientOnboarding)
      .where(eq(clientOnboarding.tenantId, tenantId));

    return [
      ...onboardedList,
      ...onboardingListDb.map((c) => ({
        id: c.id,
        name: c.clientName,
        type: 'onboarding' as const,
        existingNotes: c.notes,
      })),
    ];
  }

  /**
   * Helper: Remove remark block for a specific client
   */
  static async removeRemarksForClient(
    tenantId: string,
    client: { id: string; name: string; type: 'onboarded' | 'onboarding'; existingNotes?: string | null },
    reportId: string,
    oldMatched: string[]
  ) {
    const extractedOldPoints = oldMatched.map((l) => WorkReportsController.extractClientPoint(l, client.name));
    const allOldVariants = [...oldMatched, ...extractedOldPoints];

    // 1. Clean client_notes
    const [existingNote] = await db
      .select()
      .from(clientNotes)
      .where(and(eq(clientNotes.tenantId, tenantId), eq(clientNotes.clientId, client.id)))
      .limit(1);

    if (existingNote && existingNote.comment) {
      const cleaned = WorkReportsController.cleanReportRemarksFromText(existingNote.comment, reportId, allOldVariants);
      if (cleaned !== existingNote.comment) {
        if (cleaned.length === 0) {
          await db.delete(clientNotes).where(eq(clientNotes.id, existingNote.id));
        } else {
          await db
            .update(clientNotes)
            .set({ comment: cleaned, updatedAt: new Date() })
            .where(eq(clientNotes.id, existingNote.id));
        }
      }
    }

    // 2. If onboarding pipeline client, also clean client_onboarding.notes
    if (client.type === 'onboarding') {
      const [onboardingRow] = await db
        .select({ id: clientOnboarding.id, notes: clientOnboarding.notes })
        .from(clientOnboarding)
        .where(and(eq(clientOnboarding.id, client.id), eq(clientOnboarding.tenantId, tenantId)))
        .limit(1);

      if (onboardingRow && onboardingRow.notes) {
        const cleaned = WorkReportsController.cleanReportRemarksFromText(onboardingRow.notes, reportId, allOldVariants);
        if (cleaned !== onboardingRow.notes) {
          await db
            .update(clientOnboarding)
            .set({ notes: cleaned || null, updatedAt: new Date() })
            .where(and(eq(clientOnboarding.id, client.id), eq(clientOnboarding.tenantId, tenantId)));
        }
      }
    }
  }

  /**
   * Helper: Replace existing remark block or prepend new remark block for a specific client
   */
  static async replaceOrAddRemarksForClient(
    tenantId: string,
    client: { id: string; name: string; type: 'onboarded' | 'onboarding'; existingNotes?: string | null },
    reportId: string,
    oldMatched: string[],
    remarkEntry: string,
    authorName: string
  ) {
    const extractedOldPoints = oldMatched.map((l) => WorkReportsController.extractClientPoint(l, client.name));
    const allOldVariants = [...oldMatched, ...extractedOldPoints];

    // 1. client_notes
    const [existingNote] = await db
      .select()
      .from(clientNotes)
      .where(and(eq(clientNotes.tenantId, tenantId), eq(clientNotes.clientId, client.id)))
      .limit(1);

    if (existingNote) {
      const baseText = WorkReportsController.cleanReportRemarksFromText(existingNote.comment, reportId, allOldVariants);
      const newComment = baseText ? `${remarkEntry}\n\n${baseText}` : remarkEntry;
      await db
        .update(clientNotes)
        .set({
          comment: newComment,
          authorName: authorName || existingNote.authorName,
          updatedAt: new Date(),
        })
        .where(eq(clientNotes.id, existingNote.id));
    } else {
      await db.insert(clientNotes).values({
        tenantId,
        clientId: client.id,
        comment: remarkEntry,
        authorName,
      });
    }

    // 2. If onboarding pipeline client, also update client_onboarding.notes
    if (client.type === 'onboarding') {
      const [onboardingRow] = await db
        .select({ id: clientOnboarding.id, notes: clientOnboarding.notes })
        .from(clientOnboarding)
        .where(and(eq(clientOnboarding.id, client.id), eq(clientOnboarding.tenantId, tenantId)))
        .limit(1);

      const currentNotes = onboardingRow?.notes || '';
      const baseText = WorkReportsController.cleanReportRemarksFromText(currentNotes, reportId, allOldVariants);
      const newNotes = baseText ? `${remarkEntry}\n\n${baseText}` : remarkEntry;

      await db
        .update(clientOnboarding)
        .set({
          notes: newNotes,
          updatedAt: new Date(),
        })
        .where(and(eq(clientOnboarding.id, client.id), eq(clientOnboarding.tenantId, tenantId)));
    }
  }

  /**
   * Sync remarks when a work report is created
   */
  static async syncClientRemarks(
    tenantId: string,
    reportId: string,
    reportText: string,
    authorName: string,
    _reportDate: Date = new Date()
  ) {
    try {
      if (!tenantId || !reportText || !reportText.trim()) return;

      const allClients = await WorkReportsController.fetchAllClients(tenantId);
      if (allClients.length === 0) return;

      const lines = reportText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      for (const client of allClients) {
        const clientNameClean = client.name.trim();
        if (!clientNameClean || clientNameClean.length < 2) continue;

        const escaped = clientNameClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentionRegex = new RegExp(`(?:@|\\*\\*)?${escaped}(?:\\*\\*)?`, 'i');

        const matchedLines = lines.filter((line) => mentionRegex.test(line));

        if (matchedLines.length > 0) {
          const extractedPoints = matchedLines
            .map((l) => WorkReportsController.extractClientPoint(l, client.name))
            .filter(Boolean);

          if (extractedPoints.length === 0) continue;

          const remarkEntry =
            extractedPoints.length === 1
              ? extractedPoints[0]
              : extractedPoints.map((p) => `• ${p}`).join('\n');

          await WorkReportsController.replaceOrAddRemarksForClient(
            tenantId,
            client,
            reportId,
            [],
            remarkEntry,
            authorName
          );
        }
      }
    } catch (err: any) {
      logger.error({ msg: 'WorkReportsController.syncClientRemarks error', error: err.message });
    }
  }

  /**
   * Sync remarks when a work report is updated:
   * 1. Removes remarks from clients no longer mentioned in the report.
   * 2. Updates / adds remarks for currently mentioned clients.
   */
  static async syncClientRemarksOnUpdate(
    tenantId: string,
    reportId: string,
    oldReportText: string | null | undefined,
    newReportText: string,
    authorName: string,
    _reportDate: Date = new Date()
  ) {
    try {
      if (!tenantId || !reportId) return;

      const allClients = await WorkReportsController.fetchAllClients(tenantId);
      if (allClients.length === 0) return;

      const oldLines = oldReportText
        ? oldReportText.split('\n').map((l) => l.trim()).filter(Boolean)
        : [];
      const newLines = newReportText
        ? newReportText.split('\n').map((l) => l.trim()).filter(Boolean)
        : [];

      for (const client of allClients) {
        const clientNameClean = client.name.trim();
        if (!clientNameClean || clientNameClean.length < 2) continue;

        const escaped = clientNameClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentionRegex = new RegExp(`(?:@|\\*\\*)?${escaped}(?:\\*\\*)?`, 'i');

        const oldMatched = oldLines.filter((line) => mentionRegex.test(line));
        const newMatched = newLines.filter((line) => mentionRegex.test(line));

        // Case 1: Client was in old report, but is NO LONGER mentioned in new report
        if (oldMatched.length > 0 && newMatched.length === 0) {
          await WorkReportsController.removeRemarksForClient(tenantId, client, reportId, oldMatched);
        }
        // Case 2: Client is mentioned in new report (either newly added or updated)
        else if (newMatched.length > 0) {
          const extractedPoints = newMatched
            .map((l) => WorkReportsController.extractClientPoint(l, client.name))
            .filter(Boolean);

          if (extractedPoints.length === 0) continue;

          const remarkEntry =
            extractedPoints.length === 1
              ? extractedPoints[0]
              : extractedPoints.map((p) => `• ${p}`).join('\n');

          await WorkReportsController.replaceOrAddRemarksForClient(
            tenantId,
            client,
            reportId,
            oldMatched,
            remarkEntry,
            authorName
          );
        }
      }
    } catch (err: any) {
      logger.error({ msg: 'WorkReportsController.syncClientRemarksOnUpdate error', error: err.message });
    }
  }

  /**
   * Sync remarks when a work report is deleted:
   * Removes remarks originating from this report across all clients.
   */
  static async syncClientRemarksOnDelete(
    tenantId: string,
    reportId: string,
    oldReportText: string | null | undefined
  ) {
    try {
      if (!tenantId || !reportId) return;

      const allClients = await WorkReportsController.fetchAllClients(tenantId);
      if (allClients.length === 0) return;

      const oldLines = oldReportText
        ? oldReportText.split('\n').map((l) => l.trim()).filter(Boolean)
        : [];

      for (const client of allClients) {
        await WorkReportsController.removeRemarksForClient(tenantId, client, reportId, oldLines);
      }
    } catch (err: any) {
      logger.error({ msg: 'WorkReportsController.syncClientRemarksOnDelete error', error: err.message });
    }
  }
}
