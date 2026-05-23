import { Router } from 'express';
import multer from 'multer';
import { UploadController } from './upload.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { uploadLimiter } from '../../middleware/rateLimiter';

const router = Router();

// Configure multer memory storage
const storage = multer.memoryStorage();

// Supported MIME types
const allowedMimeTypes = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'text/plain'
];

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  }
};

const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5, // max 5 files per request
  },
  fileFilter,
});

// Protect upload routes with auth + rate limiting
router.post(
  '/',
  authenticate,
  uploadLimiter,
  uploadMiddleware.array('files', 5),
  UploadController.uploadFiles
);

router.get('/:entityType/:entityId', authenticate, UploadController.listByEntity);

export const uploadsRouter = router;
