import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../utils/AppError';
import * as DisputeService from '../../services/DisputeService';

const listDisputesQuerySchema = z.object({
  status: z.enum(['open', 'reviewed', 'resolved']).optional(),
  marketId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const disputeIdParamsSchema = z.object({
  disputeId: z.coerce.number().int().positive(),
});

export async function submitDispute(req: Request, res: Response): Promise<void> {
  const { marketId, reason } = req.body;

  const dispute = await DisputeService.createDispute(marketId, reason);

  res.status(201).json({
    success: true,
    data: dispute,
  });
}

export async function listDisputes(req: Request, res: Response): Promise<void> {
  const queryValidation = listDisputesQuerySchema.safeParse(req.query);

  if (!queryValidation.success) {
    throw AppError.badRequest('Invalid query parameters', 'VALIDATION_ERROR', queryValidation.error.issues);
  }

  const { status, marketId, page, limit } = queryValidation.data;

  const filters: DisputeService.DisputeFilters = {};
  if (status) filters.status = status;
  if (marketId) filters.marketId = marketId;

  const result = await DisputeService.listDisputes(filters, { page, limit });

  res.json({
    success: true,
    data: {
      disputes: result.data,
      pagination: result.pagination,
    },
  });
}

export async function getDispute(req: Request, res: Response): Promise<void> {
  const paramsValidation = disputeIdParamsSchema.safeParse(req.params);

  if (!paramsValidation.success) {
    throw AppError.badRequest('Invalid dispute ID', 'VALIDATION_ERROR', paramsValidation.error.issues);
  }

  const { disputeId } = paramsValidation.data;

  const dispute = await DisputeService.getDisputeById(disputeId);

  res.json({
    success: true,
    data: dispute,
  });
}

export async function reviewDispute(req: Request, res: Response): Promise<void> {
  const paramsValidation = disputeIdParamsSchema.safeParse(req.params);

  if (!paramsValidation.success) {
    throw AppError.badRequest('Invalid dispute ID', 'VALIDATION_ERROR', paramsValidation.error.issues);
  }

  const { disputeId } = paramsValidation.data;
  const { adminNotes } = req.body;

  const dispute = await DisputeService.reviewDispute(disputeId, adminNotes);

  res.json({
    success: true,
    data: dispute,
  });
}

export async function resolveDispute(req: Request, res: Response): Promise<void> {
  const paramsValidation = disputeIdParamsSchema.safeParse(req.params);

  if (!paramsValidation.success) {
    throw AppError.badRequest('Invalid dispute ID', 'VALIDATION_ERROR', paramsValidation.error.issues);
  }

  const { disputeId } = paramsValidation.data;
  const { action, resolution, newWinningOutcome, notifyEmail } = req.body;

  let finalOutcome: string;
  if (action === 'DISMISS') {
    finalOutcome = 'dismissed';
  } else if (action === 'RESOLVE_NEW_OUTCOME') {
    if (newWinningOutcome === undefined) {
      throw AppError.badRequest('New winning outcome required for RESOLVE_NEW_OUTCOME action');
    }
    finalOutcome = `resolved_outcome_${newWinningOutcome}`;
  } else {
    throw AppError.badRequest('Invalid action');
  }

  const dispute = await DisputeService.resolveDispute(disputeId, finalOutcome, resolution, notifyEmail);

  res.json({
    success: true,
    data: dispute,
  });
}
