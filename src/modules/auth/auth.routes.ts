import { Router } from 'express';
import { AuthController } from './auth.controller';
import { validateRequest } from '../../middleware/validate.middleware';
import { loginSchema, refreshSchema, logoutSchema, forgotPasswordSchema, resetPasswordSchema } from './auth.schema';
import { authenticate } from '../../middleware/auth.middleware';

import { authLimiter } from '../../middleware/rateLimiter';

const router = Router();

router.post('/login', authLimiter, validateRequest(loginSchema), AuthController.login);
router.post('/refresh', authLimiter, validateRequest(refreshSchema), AuthController.refresh);
router.post('/logout', authenticate, validateRequest(logoutSchema), AuthController.logout);
router.post('/forgot-password', authLimiter, validateRequest(forgotPasswordSchema), AuthController.forgotPassword);
router.post('/reset-password', authLimiter, validateRequest(resetPasswordSchema), AuthController.resetPassword);
router.get('/me', authenticate, AuthController.me);

export const authRouter = router;
