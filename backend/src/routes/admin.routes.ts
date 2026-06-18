import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError';
import { flagDispute, investigateDispute, cancelMarket, resolveDispute, listDisputes, processRefunds, bulkPause, bulkCancel } from '../api/controllers/AdminController';
import {
  logExportAudit,
  streamUsersExport,
  streamTradesExport,
  streamTreasuryExport,
  buildTradesCsv,
} from '../services/export.service';
import { sendExportReadyEmail } from '../services/email.service';
import { getRiskEngine } from '../services/RiskEngine';
import { getOrSet } from '../services/cache.service';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Admin-only operations
 */

// ---------------------------------------------------------------------------
// Admin middleware — verifies JWT and checks admin role
// ---------------------------------------------------------------------------
async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(401, 'Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;

    if (payload.type !== 'access') {
      throw new AppError(401, 'Invalid token type');
    }

    const userId = payload.sub as string;
    const sessionVersion: number = payload.sv ?? 0;

    (req as unknown as Record<string, unknown>).userId = userId;
    (req as unknown as Record<string, unknown>).sessionVersion = sessionVersion;
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(401, 'Invalid or expired token'));
  }
}

/**
 * @swagger
 * /admin/disputes:
 *   get:
 *     summary: List all disputes (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of disputes
 *       401:
 *         description: Unauthorized
 */
router.get('/disputes', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await listDisputes(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/dispute/{market_id}:
 *   post:
 *     summary: Flag a market dispute (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dispute flagged
 *       401:
 *         description: Unauthorized
 */
router.post('/dispute/:market_id', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await flagDispute(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/dispute/{market_id}/investigate:
 *   post:
 *     summary: Mark a dispute as under investigation (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dispute under investigation
 *       401:
 *         description: Unauthorized
 */
router.post('/dispute/:market_id/investigate', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await investigateDispute(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/cancel/{market_id}/refunds:
 *   post:
 *     summary: Process refunds for a cancelled market (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Refunds processed
 *       401:
 *         description: Unauthorized
 */
router.post('/cancel/:market_id/refunds', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await processRefunds(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/resolve-dispute/{market_id}:
 *   post:
 *     summary: Resolve a dispute for a market (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [DISMISS, RESOLVE_NEW_OUTCOME]
 *               newWinningOutcome:
 *                 type: integer
 *                 enum: [0, 1]
 *     responses:
 *       200:
 *         description: Dispute resolved
 *       401:
 *         description: Unauthorized
 */
router.post('/resolve-dispute/:market_id', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await resolveDispute(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/cancel/{market_id}:
 *   post:
 *     summary: Cancel a market (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Market cancelled
 *       401:
 *         description: Unauthorized
 */
router.post('/cancel/:market_id', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await cancelMarket(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/markets/bulk-pause:
 *   post:
 *     summary: Pause multiple markets (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [marketIds]
 *             properties:
 *               marketIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Markets paused
 *       401:
 *         description: Unauthorized
 */
router.post('/markets/bulk-pause', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try { await bulkPause(req, res); } catch (err) { next(err); }
});

/**
 * @swagger
 * /admin/markets/bulk-cancel:
 *   post:
 *     summary: Cancel multiple markets (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [marketIds]
 *             properties:
 *               marketIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Markets cancelled
 *       401:
 *         description: Unauthorized
 */
router.post('/markets/bulk-cancel', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try { await bulkCancel(req, res); } catch (err) { next(err); }
});

/**
 * @swagger
 * /admin/export/users:
 *   get:
 *     summary: Stream users CSV export (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: CSV file stream
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *       401:
 *         description: Unauthorized
 */
router.get('/export/users', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as unknown as Record<string, unknown>).userId as string;
    await logExportAudit(adminId, 'users');
    await streamUsersExport(res);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/export/trades:
 *   get:
 *     summary: Stream trades CSV export (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: CSV file stream
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *       401:
 *         description: Unauthorized
 */
router.get('/export/trades', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as unknown as Record<string, unknown>).userId as string;
    const { from, to } = req.query as { from?: string; to?: string };
    await logExportAudit(adminId, 'trades', { from, to });
    await streamTradesExport(res, from, to);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/export/treasury:
 *   get:
 *     summary: Stream treasury CSV export (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: CSV file stream
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *       401:
 *         description: Unauthorized
 */
router.get('/export/treasury', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as unknown as Record<string, unknown>).userId as string;
    await logExportAudit(adminId, 'treasury');
    await streamTreasuryExport(res);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/export/request:
 *   post:
 *     summary: Queue an async export and email it when ready (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, email]
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [trades]
 *               email:
 *                 type: string
 *                 format: email
 *               from:
 *                 type: string
 *                 format: date
 *               to:
 *                 type: string
 *                 format: date
 *     responses:
 *       202:
 *         description: Export queued
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
router.post('/export/request', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as unknown as Record<string, unknown>).userId as string;
    const { type, from, to, email } = req.body as { type: string; from?: string; to?: string; email: string };

    if (!email || typeof email !== 'string') throw new AppError(400, 'email is required');
    if (type !== 'trades') throw new AppError(400, 'type must be "trades"');

    await logExportAudit(adminId, `async:${type}`, { from, to, email });

    // Respond immediately; build + send in background
    res.status(202).json({ message: 'Export queued. You will receive an email when ready.' });

    setImmediate(async () => {
      try {
        const csv = await buildTradesCsv(from, to);
        await sendExportReadyEmail(email, type, csv);
      } catch (err) {
        // Background failure — already responded 202, just log
        const { logger } = await import('../utils/logger');
        logger.error({ msg: 'Async export failed', err });
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /admin/risk/exposure:
 *   get:
 *     summary: Real-time pool exposure and circuit breaker status (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Imbalance ratios for all open markets, platform total exposure, and last 10 circuit breaker events
 *       401:
 *         description: Unauthorized
 */
router.get('/risk/exposure', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await getOrSet('admin:risk:exposure', 10, () => getRiskEngine().getExposureReport());
    res.json(report);
  } catch (err) {
    next(err);
  }
});

export default router;
