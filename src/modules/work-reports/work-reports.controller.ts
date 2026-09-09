import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { db } from '../../db';
import { workReports } from '../../db/schema/work_reports';
import { eq, and, desc } from 'drizzle-orm';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
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

      return res.json({
        success: true,
        message: 'Work report deleted successfully',
      });
    } catch (err: any) {
      logger.error({ msg: 'WorkReportsController.delete error', error: err.message });
      return res.status(500).json({ error: 'Failed to delete work report' });
    }
  }
}
