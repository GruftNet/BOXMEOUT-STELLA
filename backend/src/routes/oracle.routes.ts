import { Router } from 'express';
import {
  submitOracleResult,
  validateSubmitOracleResult,
  getOracleReports,
  getLeaderboard,
} from '../api/controllers/OracleController';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Oracle
 *   description: Oracle result submission and transparency reports
 */

/**
 * @swagger
 * /oracle/submit:
 *   post:
 *     summary: Submit an oracle result for a match
 *     tags: [Oracle]
 *     description: Requires a valid ORACLE_API_KEY in the X-Oracle-Key header
 *     parameters:
 *       - in: header
 *         name: X-Oracle-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [matchId, winningOutcome]
 *             properties:
 *               matchId:
 *                 type: string
 *               winningOutcome:
 *                 type: integer
 *                 enum: [0, 1]
 *               reportedAt:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Oracle result submitted
 *       401:
 *         description: Invalid or missing API key
 *       400:
 *         description: Validation error
 */
router.post('/submit', validateSubmitOracleResult, submitOracleResult);

/**
 * @swagger
 * /oracle/reports/{match_id}:
 *   get:
 *     summary: Get oracle reports for a match (public transparency endpoint)
 *     tags: [Oracle]
 *     parameters:
 *       - in: path
 *         name: match_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of oracle reports for the match
 *       404:
 *         description: No reports found
 */
router.get('/reports/:match_id', getOracleReports);

/**
 * @swagger
 * /oracle/leaderboard:
 *   get:
 *     summary: Get all registered oracles sorted by reputation score
 *     tags: [Oracle]
 *     description: >
 *       Returns oracle performance metrics from the oracle_reports table,
 *       enriched with on-chain stake status from the OracleRegistry contract.
 *       Oracles are sorted by accepted_reports descending (reputation proxy).
 *     responses:
 *       200:
 *         description: Oracle leaderboard
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 leaderboard:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       oracle_address:
 *                         type: string
 *                       total_reports:
 *                         type: integer
 *                       accepted_reports:
 *                         type: integer
 *                       slash_count:
 *                         type: integer
 *                       is_staked:
 *                         type: boolean
 */
router.get('/leaderboard', getLeaderboard);

export default router;
