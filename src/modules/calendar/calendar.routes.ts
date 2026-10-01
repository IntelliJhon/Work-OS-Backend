import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthRequest } from '../../middleware/auth.middleware';
import { isEncryptionConfigured } from '../../lib/crypto';
import { logger } from '../../config/logger';
import { CalendarService, FEED_TOKEN_RE } from './calendar.service';
import { checkSection } from '../sections/sections.service';

export const calendarRouter = Router();

const feedUnavailable = (res: Response) =>
  res.status(503).json({ error: 'Calendar links are not configured on this server', code: 'not_configured' });

// GET /api/calendar/feed - the signed-in user's private calendar link token
calendarRouter.get('/feed', authenticate as any, checkSection('calendar') as any, (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isEncryptionConfigured()) return feedUnavailable(res);
    const token = await CalendarService.getFeedToken(req.user!.tenantId, req.user!.id);
    return res.json({ success: true, token });
  } catch (err) {
    return next(err);
  }
}) as any);

// POST /api/calendar/feed/reset - a new link; the old one stops working
calendarRouter.post('/feed/reset', authenticate as any, checkSection('calendar') as any, (async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isEncryptionConfigured()) return feedUnavailable(res);
    const token = await CalendarService.resetFeedToken(req.user!.tenantId, req.user!.id);
    logger.info({ tenantId: req.user!.tenantId, userId: req.user!.id }, '[Calendar] Calendar link reset');
    return res.json({ success: true, token });
  } catch (err) {
    return next(err);
  }
}) as any);

// GET /api/calendar/<token>.ics - the feed calendar apps subscribe to. No login: the token is the credential.
calendarRouter.get('/:file', async (req, res, next) => {
  try {
    const match = /^(.+)\.ics$/.exec(String(req.params.file));
    if (!match || !FEED_TOKEN_RE.test(match[1])) return res.status(404).send('Not found');
    const ics = await CalendarService.buildFeed(match[1]);
    if (!ics) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="work-os.ics"');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(ics);
  } catch (err) {
    return next(err);
  }
});
