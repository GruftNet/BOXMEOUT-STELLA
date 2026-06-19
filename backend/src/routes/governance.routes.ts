import { Router } from 'express';
import {
  getProposal,
  listProposals,
  voteOnProposal,
} from '../api/controllers/GovernanceController';

const router = Router();

router.get('/proposals', listProposals);
router.get('/proposals/:id', getProposal);
router.post('/proposals/:id/vote', voteOnProposal);

export default router;
