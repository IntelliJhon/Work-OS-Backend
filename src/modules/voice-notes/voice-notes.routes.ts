import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requirePermissions } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validate.middleware';
import { VoiceNotesController } from './voice-notes.controller';
import { VoiceIntegrationController, requireIntegrationSecret } from './voice-integration.controller';
import {
  sendCodeSchema,
  verifyCodeSchema,
  listVoiceNotesSchema,
  updateVoiceNoteSchema,
  deleteVoiceNoteSchema,
  ingestVoiceNoteSchema,
  assignVoiceNoteSchema,
} from './voice-notes.schema';

// Permission keys. Admin role bypasses all checks in requirePermissions.
export const VOICE_PERMISSIONS = {
  SETTINGS_MANAGE: 'workspace.voice.manage',
  NOTES_READ: 'voice_notes.read',
  NOTES_UPDATE: 'voice_notes.update',
} as const;

// ---- /api/voice-notes (logged-in users) ----
export const voiceNotesRouter = Router();
voiceNotesRouter.use(authenticate as any);

// Settings (registered before '/:id' so "settings" is never treated as an id)
voiceNotesRouter.get('/settings', requirePermissions([VOICE_PERMISSIONS.SETTINGS_MANAGE]) as any, VoiceNotesController.getSettings as any);
voiceNotesRouter.post('/settings/send-code', requirePermissions([VOICE_PERMISSIONS.SETTINGS_MANAGE]) as any, validateRequest(sendCodeSchema), VoiceNotesController.sendCode as any);
voiceNotesRouter.post('/settings/verify', requirePermissions([VOICE_PERMISSIONS.SETTINGS_MANAGE]) as any, validateRequest(verifyCodeSchema), VoiceNotesController.verifyCode as any);
voiceNotesRouter.delete('/settings', requirePermissions([VOICE_PERMISSIONS.SETTINGS_MANAGE]) as any, VoiceNotesController.removeNumber as any);

// Inbox
voiceNotesRouter.get('/', requirePermissions([VOICE_PERMISSIONS.NOTES_READ]) as any, validateRequest(listVoiceNotesSchema), VoiceNotesController.list as any);
voiceNotesRouter.patch('/:id', requirePermissions([VOICE_PERMISSIONS.NOTES_UPDATE]) as any, validateRequest(updateVoiceNoteSchema), VoiceNotesController.update as any);
voiceNotesRouter.delete('/:id', requirePermissions([VOICE_PERMISSIONS.NOTES_UPDATE]) as any, validateRequest(deleteVoiceNoteSchema), VoiceNotesController.remove as any);

// ---- /api/integrations (machine-to-machine, secret header) ----
export const integrationsRouter = Router();
integrationsRouter.post('/voice-notes', requireIntegrationSecret, validateRequest(ingestVoiceNoteSchema), VoiceIntegrationController.ingest);
integrationsRouter.post('/voice-notes/assign', requireIntegrationSecret, validateRequest(assignVoiceNoteSchema), VoiceIntegrationController.assign);
