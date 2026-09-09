import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth.middleware';
import { WorkReportsController } from './work-reports.controller';

export const workReportsRouter = Router();

const storage = multer.memoryStorage();
const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit
  },
});

workReportsRouter.use(authenticate as any);

// GET /api/work-reports/employee/:employeeId - List all work reports for employee
workReportsRouter.get('/employee/:employeeId', WorkReportsController.listByEmployee as any);

// POST /api/work-reports - Submit a new work report
workReportsRouter.post('/', uploadMiddleware.single('file'), WorkReportsController.create as any);

// PUT /api/work-reports/:id - Edit work report
workReportsRouter.put('/:id', uploadMiddleware.single('file'), WorkReportsController.update as any);

// PATCH /api/work-reports/:id - Edit work report
workReportsRouter.patch('/:id', uploadMiddleware.single('file'), WorkReportsController.update as any);

// DELETE /api/work-reports/:id - Delete work report
workReportsRouter.delete('/:id', WorkReportsController.delete as any);
