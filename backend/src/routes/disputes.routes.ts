import { Router, Request, Response, NextFunction } from 'express';
import * as disputesController from '../api/controllers/DisputeController';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { validate } from '../api/middleware/validate';
import {
  submitDisputeBody,
  reviewDisputeBody,
  resolveDisputeBody,
} from '../schemas/validation.schemas';

const router: Router = Router();

/**
 * @swagger
 * tags:
 *   name: Disputes
 *   description: Market dispute management
 */

/**
 * @swagger
 * /api/disputes:
 *   post:
 *     summary: Submit a new dispute
 *     description: User challenges an oracle report by submitting a dispute
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - marketId
 *               - reason
 *             properties:
 *               marketId:
 *                 type: string
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 1000
 *               evidenceUrl:
 *                 type: string
 *                 format: url
 *     responses:
 *       201:
 *         description: Dispute submitted successfully
 *       400:
 *         description: Bad request or invalid market status
 *       401:
 *         description: Unauthorized
 *       409:
 *         description: Dispute already exists for this market
 */
router.post(
  '/',
  validate(submitDisputeBody, 'body'),
  (req: Request, res: Response, next: NextFunction) => {
    disputesController.submitDispute(req, res).catch(next);
  }
);

/**
 * @swagger
 * /api/disputes:
 *   get:
 *     summary: List all disputes (Admin only)
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [open, reviewed, resolved]
 *         description: Filter by dispute status
 *       - name: marketId
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by market ID
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Paginated list of disputes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 disputes:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Dispute'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *                     hasNext:
 *                       type: boolean
 *                     hasPrev:
 *                       type: boolean
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.get(
  '/',
  requireAdminJwt,
  (req: Request, res: Response, next: NextFunction) => {
    disputesController.listDisputes(req, res).catch(next);
  }
);

/**
 * @swagger
 * /api/disputes/{disputeId}:
 *   get:
 *     summary: Get dispute details
 *     tags: [Disputes]
 *     parameters:
 *       - name: disputeId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dispute details
 *       404:
 *         description: Dispute not found
 */
router.get('/:disputeId', (req: Request, res: Response, next: NextFunction) => {
  disputesController.getDispute(req, res).catch(next);
});

/**
 * @swagger
 * /api/disputes/{disputeId}/review:
 *   patch:
 *     summary: Review a dispute (Admin only)
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: disputeId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - adminNotes
 *             properties:
 *               adminNotes:
 *                 type: string
 *                 minLength: 5
 *                 maxLength: 5000
 *     responses:
 *       200:
 *         description: Dispute updated to reviewed
 *       400:
 *         description: Bad request - dispute not in open status
 *       403:
 *         description: Forbidden - Admin access required
 *       404:
 *         description: Dispute not found
 */
router.patch(
  '/:disputeId/review',
  requireAdminJwt,
  validate(reviewDisputeBody, 'body'),
  (req: Request, res: Response, next: NextFunction) => {
    disputesController.reviewDispute(req, res).catch(next);
  }
);

/**
 * @swagger
 * /api/disputes/{disputeId}/resolve:
 *   patch:
 *     summary: Resolve a dispute (Admin only)
 *     description: Admin resolves a reviewed dispute
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: disputeId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *               - resolution
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [DISMISS, RESOLVE_NEW_OUTCOME]
 *               resolution:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 5000
 *               adminNotes:
 *                 type: string
 *                 minLength: 5
 *                 maxLength: 5000
 *               newWinningOutcome:
 *                 type: integer
 *                 enum: [0, 1]
 *               notifyEmail:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Dispute resolved successfully
 *       400:
 *         description: Invalid action or dispute not reviewed yet
 *       403:
 *         description: Forbidden - Admin access required
 *       404:
 *         description: Dispute not found
 */
router.patch(
  '/:disputeId/resolve',
  requireAdminJwt,
  validate(resolveDisputeBody, 'body'),
  (req: Request, res: Response, next: NextFunction) => {
    disputesController.resolveDispute(req, res).catch(next);
  }
);

export default router;
