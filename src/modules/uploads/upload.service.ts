import { db } from '../../db';
import { uploads } from '../../db/schema/uploads';
import { tasks } from '../../db/schema/tasks';
import { qualityGates } from '../../db/schema/quality_gates';
import { users } from '../../db/schema/users';
import { phases } from '../../db/schema/phases';
import { withTenant } from '../../middleware/tenant.middleware';
import { uploadStream, getSignedDownloadUrl, deleteFile } from './cloudinary';
import { uploadLogger } from '../../lib/logger';
import { and, eq, or, inArray, sql } from 'drizzle-orm';


interface UploadParams {
  tenantId: string;
  uploaderId: string;
  entityType: string;
  entityId: string;
  file: Express.Multer.File;
}

export class UploadService {
  static async processUpload(params: UploadParams) {
    const { tenantId, uploaderId, entityType, entityId, file } = params;

    try {
      // 1. Upload to Cloudinary
      uploadLogger.info({ tenantId, uploaderId, fileName: file.originalname }, 'Starting file upload to Cloudinary');
      
      const folder = `${tenantId}/${entityType.toLowerCase()}`;
      const cldResult = await uploadStream(file.buffer, folder, file.originalname);

      // 2. Persist to Database securely inside RLS tenant context
      const result = await withTenant(tenantId, async (tx: any) => {
        const [insertedRow] = await tx.insert(uploads).values({
          tenantId,
          uploaderUserId: uploaderId,
          entityType,
          entityId,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          storageKey: cldResult.public_id,
          publicUrl: cldResult.secure_url,
        }).returning();

        return insertedRow;
      });

      uploadLogger.info({ uploadId: result.id, tenantId }, 'File upload recorded successfully');
      return result;
    } catch (error: any) {
      uploadLogger.error({ tenantId, uploaderId, error: error.message }, 'File upload failed');
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  static async getUploadsByEntity(tenantId: string, entityType: string, entityId: string) {
    return await withTenant(tenantId, async (tx: any) => {
      return await tx.select().from(uploads).where(
        and(
          eq(uploads.tenantId, tenantId),
          eq(uploads.entityType, entityType),
          eq(uploads.entityId, entityId)
        )
      );
    });
  }

  static async getAllProjectUploads(tenantId: string, projectId: string) {
    return await withTenant(tenantId, async (tx: any) => {
      // 1. Get task IDs and names
      const projectTasks = await tx
        .select({ id: tasks.id, name: tasks.name })
        .from(tasks)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.projectId, projectId)));
      const taskMap = new Map(projectTasks.map((t: any) => [t.id, t.name]));
      const taskIds = projectTasks.map((t: any) => t.id);

      // 2. Get gate IDs and phase names
      const projectGates = await tx
        .select({ id: qualityGates.id, phaseName: phases.name })
        .from(qualityGates)
        .innerJoin(phases, eq(qualityGates.phaseId, phases.id))
        .where(and(eq(qualityGates.tenantId, tenantId), eq(qualityGates.projectId, projectId)));
      const gateMap = new Map(projectGates.map((g: any) => [g.id, g.phaseName]));
      const gateIds = projectGates.map((g: any) => g.id);

      // 3. Build conditions
      const conditions = [
        and(eq(uploads.entityType, 'PROJECT'), eq(uploads.entityId, projectId))
      ];

      if (taskIds.length > 0) {
        conditions.push(and(eq(uploads.entityType, 'TASK'), inArray(uploads.entityId, taskIds)));
      }

      if (gateIds.length > 0) {
        conditions.push(and(eq(uploads.entityType, 'GATE'), inArray(uploads.entityId, gateIds)));
      }

      const rawUploads = await tx
        .select({
          id: uploads.id,
          tenantId: uploads.tenantId,
          uploaderUserId: uploads.uploaderUserId,
          entityType: uploads.entityType,
          entityId: uploads.entityId,
          originalName: uploads.originalName,
          mimeType: uploads.mimeType,
          size: uploads.size,
          storageKey: uploads.storageKey,
          publicUrl: uploads.publicUrl,
          createdAt: uploads.createdAt,
          uploaderName: sql`concat(${users.firstName}, ' ', ${users.lastName})`
        })
        .from(uploads)
        .leftJoin(users, eq(uploads.uploaderUserId, users.id))
        .where(
          and(
            eq(uploads.tenantId, tenantId),
            or(...conditions)
          )
        );

      const enrichedUploads = rawUploads.map((upload: any) => {
        let sourceName = 'Project Scope';
        if (upload.entityType === 'TASK') {
          sourceName = `Task: ${taskMap.get(upload.entityId) || 'Unknown Task'}`;
        } else if (upload.entityType === 'GATE') {
          sourceName = `Quality Gate: ${gateMap.get(upload.entityId) || 'Unknown Gate'}`;
        }
        return {
          ...upload,
          sourceName,
        };
      });

      return enrichedUploads;
    });
  }

  static async getSignedDownloadUrl(tenantId: string, uploadId: string): Promise<string> {
    const result = await withTenant(tenantId, async (tx: any) => {
      const rows = await tx.select().from(uploads).where(
        and(
          eq(uploads.tenantId, tenantId),
          eq(uploads.id, uploadId)
        )
      );
      return rows[0];
    });

    if (!result) {
      throw new Error('Upload file not found');
    }

    return getSignedDownloadUrl(result.storageKey, result.mimeType, result.originalName);
  }

  static async deleteUpload(tenantId: string, uploadId: string): Promise<void> {
    const result = await withTenant(tenantId, async (tx: any) => {
      const rows = await tx.select().from(uploads).where(
        and(
          eq(uploads.tenantId, tenantId),
          eq(uploads.id, uploadId)
        )
      );
      return rows[0];
    });

    if (!result) {
      throw new Error('Upload file not found or access denied');
    }

    // 1. Delete from Cloudinary
    try {
      await deleteFile(result.storageKey, result.mimeType);
    } catch (error: any) {
      uploadLogger.warn({ uploadId, error: error.message }, 'Failed to delete file from Cloudinary (might be already deleted)');
    }

    // 2. Delete from Database
    await withTenant(tenantId, async (tx: any) => {
      await tx.delete(uploads).where(
        and(
          eq(uploads.tenantId, tenantId),
          eq(uploads.id, uploadId)
        )
      );
    });

    uploadLogger.info({ uploadId, tenantId }, 'File upload deleted successfully');
  }
}
