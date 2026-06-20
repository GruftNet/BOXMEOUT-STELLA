import { getOrSet, del } from './cache.service';

export interface Proposal {
  id: string;
  type: string;
  value: string | number;
  description: string;
  status: 'Active' | 'Passed' | 'Failed' | 'Executed';
  proposer: string;
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  createdAt: string;
  expiresAt: string;
}

export interface VoteRecord {
  proposalId: string;
  voter: string;
  vote: 'for' | 'against' | 'abstain';
}

const CACHE_TTL = 30;
const CACHE_KEY = 'governance:proposals';

const proposals: Proposal[] = [
  {
    id: 'prop_1',
    type: 'fee_rate',
    value: 40,
    description: 'Increase the fee rate to 40 bps to support the treasury.',
    status: 'Active',
    proposer: 'CBX...4A',
    votesFor: 50000,
    votesAgainst: 15000,
    votesAbstain: 5000,
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    expiresAt: new Date(Date.now() + 86400000 * 5).toISOString(),
  },
  {
    id: 'prop_2',
    type: 'add_token',
    value: 'CBZ...X1',
    description: 'Add USDC to the approved token list for market settlements.',
    status: 'Passed',
    proposer: 'CCM...9Z',
    votesFor: 120000,
    votesAgainst: 10000,
    votesAbstain: 0,
    createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    expiresAt: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
  {
    id: 'prop_3',
    type: 'max_discount_rate',
    value: 600,
    description: 'Change the maximum discount rate to 600 bps.',
    status: 'Executed',
    proposer: 'CDM...8B',
    votesFor: 80000,
    votesAgainst: 20000,
    votesAbstain: 2000,
    createdAt: new Date(Date.now() - 86400000 * 20).toISOString(),
    expiresAt: new Date(Date.now() - 86400000 * 13).toISOString(),
  },
  {
    id: 'prop_4',
    type: 'remove_token',
    value: 'CBY...Z3',
    description: 'Remove AQUA from the approved tokens due to low liquidity.',
    status: 'Failed',
    proposer: 'CBM...1A',
    votesFor: 30000,
    votesAgainst: 90000,
    votesAbstain: 10000,
    createdAt: new Date(Date.now() - 86400000 * 15).toISOString(),
    expiresAt: new Date(Date.now() - 86400000 * 8).toISOString(),
  },
];

const voteRecords: VoteRecord[] = [];

export interface ProposalListOptions {
  status?: string;
  page?: number;
  limit?: number;
}

export interface ProposalListResponse {
  proposals: Proposal[];
  total: number;
  page: number;
  limit: number;
}

export async function getProposals(options: ProposalListOptions): Promise<ProposalListResponse> {
  const { status, page = 1, limit = 20 } = options;

  const cacheKey = `${CACHE_KEY}:${status ?? 'all'}:${page}:${limit}`;

  return getOrSet<ProposalListResponse>(cacheKey, CACHE_TTL, async () => {
    let filtered = [...proposals];

    if (status) {
      filtered = filtered.filter((p) => p.status.toLowerCase() === status.toLowerCase());
    }

    const total = filtered.length;
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);

    return { proposals: paginated, total, page, limit };
  });
}

export async function getProposalById(id: string): Promise<Proposal | null> {
  return proposals.find((p) => p.id === id) ?? null;
}

export async function castVote(
  proposalId: string,
  voter: string,
  vote: 'for' | 'against' | 'abstain',
): Promise<{ success: boolean; alreadyVoted: boolean }> {
  const proposal = proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    return { success: false, alreadyVoted: false };
  }

  const existingVote = voteRecords.find(
    (r) => r.proposalId === proposalId && r.voter === voter,
  );
  if (existingVote) {
    return { success: false, alreadyVoted: true };
  }

  voteRecords.push({ proposalId, voter, vote });

  const index = proposals.findIndex((p) => p.id === proposalId);
  if (vote === 'for') proposals[index].votesFor += 1;
  else if (vote === 'against') proposals[index].votesAgainst += 1;
  else proposals[index].votesAbstain += 1;

  await del(`${CACHE_KEY}:*`);

  return { success: true, alreadyVoted: false };
}

export async function hasVoted(proposalId: string, voter: string): Promise<boolean> {
  return voteRecords.some((r) => r.proposalId === proposalId && r.voter === voter);
}
