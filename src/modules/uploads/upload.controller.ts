import { Request, Response, NextFunction } from 'express';
import { UploadService } from './upload.service';

export class UploadController {
  static async uploadFiles(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = (req as any).user!.tenantId;
      const uploaderId = (req as any).user!.id;
      const { entityType, entityId } = req.body;

      if (!entityType || !entityId) {
        res.status(400).json({ error: 'entityType and entityId are required' });
        return;
      }

      if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        res.status(400).json({ error: 'No files uploaded' });
        return;
      }

      const results = [];
      for (const file of req.files) {
        const result = await UploadService.processUpload({
          tenantId,
          uploaderId,
          entityType,
          entityId,
          file,
        });
        results.push(result);
      }

      res.status(201).json({
        message: 'Files uploaded successfully',
        uploads: results,
      });
    } catch (error) {
      next(error);
    }
  }

  static async listByEntity(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = (req as any).user!.tenantId;
      const entityType = req.params.entityType as string;
      const entityId = req.params.entityId as string;

      const results = await UploadService.getUploadsByEntity(tenantId, entityType, entityId);

      res.json(results);
    } catch (error) {
      next(error);
    }
  }
}
