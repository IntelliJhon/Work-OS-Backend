import { db } from '../../db';
import { uploads } from '../../db/schema/uploads';
import { withTenant } from '../../middleware/tenant.middleware';
import { uploadStream, getSignedDownloadUrl } from './cloudinary';
import { uploadLogger } from '../../lib/logger';
import { and, eq } from 'drizzle-orm';


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
}
