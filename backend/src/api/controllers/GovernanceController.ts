import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';
import { AppError } from '../../utils/AppError';
import * as GovernanceService from '../../services/GovernanceService';

const VALID_PROPOSAL_STATUSES = ['Active', 'Passed', 'Failed', 'Executed'] as const;

const listProposalsQuerySchema = z.object({
  status: z.enum(VALID_PROPOSAL_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function getProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const proposal = await GovernanceService.getProposalById(id);
    if (!proposal) {
      throw AppError.notFound(`Proposal not found: ${id}`);
    }
    res.status(200).json(proposal);
  } catch (err) {
    next(err);
  }
}

export async function listProposals(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listProposalsQuerySchema.parse(req.query);
    const { status, page, limit } = parsed;
    const result = await GovernanceService.getProposals({ status, page, limit });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

const voteBodySchema = z.object({
  voter: z.string().refine((v) => StrKey.isValidEd25519PublicKey(v), {
    message: 'Invalid Stellar address',
  }),
  vote: z.enum(['for', 'against', 'abstain']),
});

export async function voteOnProposal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const parsed = voteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((e) => ({ field: e.path.join('.'), message: e.message }));
      res.status(400).json({ errors });
      return;
    }

    const { voter, vote } = parsed.data;

    const proposal = await GovernanceService.getProposalById(id);
    if (!proposal) {
      throw AppError.notFound(`Proposal not found: ${id}`);
    }

    if (proposal.status !== 'Active') {
      throw AppError.badRequest('Proposal is not active');
    }

    const result = await GovernanceService.castVote(id, voter, vote);
    if (result.alreadyVoted) {
      res.status(409).json({ error: 'Already voted on this proposal' });
      return;
    }

    const updated = await GovernanceService.getProposalById(id);
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}
