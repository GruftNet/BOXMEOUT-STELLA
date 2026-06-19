/**
 * Test setup file for hooks testing with Mock Service Worker (MSW).
 * Exports handlers and server for use in tests.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { Market, Proposal } from '../../types';
import type { MarketListResponse, ProposalListResponse } from '../../services/api';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

/**
 * Mock market data for testing
 */
export const mockMarkets: Market[] = [
  {
    market_id: 'market-1',
    match_id: 'match-1',
    fighter_a: 'Fighter A',
    fighter_b: 'Fighter B',
    weight_class: 'Welterweight',
    title_fight: false,
    venue: 'Las Vegas',
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    status: 'open',
    outcome: null,
    pool_a: '1000000000',
    pool_b: '1000000000',
    pool_draw: '500000000',
    total_pool: '2500000000',
    odds_a: 5000,
    odds_b: 5000,
    odds_draw: 2500,
    fee_bps: 250,
  },
  {
    market_id: 'market-2',
    match_id: 'match-2',
    fighter_a: 'Fighter C',
    fighter_b: 'Fighter D',
    weight_class: 'Heavyweight',
    title_fight: true,
    venue: 'London',
    scheduled_at: new Date(Date.now() - 86400000).toISOString(),
    status: 'resolved',
    outcome: 'fighter_a',
    pool_a: '2000000000',
    pool_b: '1000000000',
    pool_draw: '500000000',
    total_pool: '3500000000',
    odds_a: 6667,
    odds_b: 3333,
    odds_draw: 2000,
    fee_bps: 250,
    oracle_address: 'GBVYSS33IUACWLMXQ6K7LQXQE4FHFFSQK75BQSB7NJZL67WTDQ4IIHL',
    resolution_tx_hash: 'c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  },
];

/**
 * MSW request handlers
 */
export const handlers = [
  // GET /api/markets
  http.get(`${API_BASE}/api/markets`, ({ request }) => {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') ?? '1');
    const limit = parseInt(url.searchParams.get('limit') ?? '20');
    const status = url.searchParams.get('status');

    let filtered = [...mockMarkets];
    if (status) {
      filtered = filtered.filter((m) => m.status === status);
    }

    const response: MarketListResponse = {
      markets: filtered.slice((page - 1) * limit, page * limit),
      total: filtered.length,
      page,
      limit,
    };

    return HttpResponse.json(response);
  }),

  // GET /api/markets/:market_id
  http.get(`${API_BASE}/api/markets/:market_id`, ({ params }) => {
    const { market_id } = params;
    const market = mockMarkets.find((m) => m.market_id === market_id);

    if (!market) {
      return HttpResponse.json(
        { error: 'Market not found' },
        { status: 404 }
      );
    }

    return HttpResponse.json(market);
  }),
];

// ─── Governance mock data ────────────────────────────────────────────────────

export const mockProposals: Proposal[] = [
  {
    id: 'prop_1',
    type: 'fee_rate',
    value: 40,
    description: 'Increase fee rate to 40 bps.',
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
    description: 'Add USDC to the approved token list.',
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
    description: 'Change max discount rate to 600 bps.',
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
    description: 'Remove AQUA from approved tokens.',
    status: 'Failed',
    proposer: 'CBM...1A',
    votesFor: 30000,
    votesAgainst: 90000,
    votesAbstain: 10000,
    createdAt: new Date(Date.now() - 86400000 * 15).toISOString(),
    expiresAt: new Date(Date.now() - 86400000 * 8).toISOString(),
  },
];

let governanceVotes: Record<string, string[]> = {};

export const governanceHandlers = [
  // GET /api/governance/proposals
  http.get(`${API_BASE}/api/governance/proposals`, ({ request }) => {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') ?? '1');
    const limit = parseInt(url.searchParams.get('limit') ?? '20');
    const status = url.searchParams.get('status');

    let filtered = [...mockProposals];
    if (status) {
      filtered = filtered.filter((p) => p.status.toLowerCase() === status.toLowerCase());
    }

    const response: ProposalListResponse = {
      proposals: filtered.slice((page - 1) * limit, page * limit),
      total: filtered.length,
      page,
      limit,
    };

    return HttpResponse.json(response);
  }),

  // GET /api/governance/proposals/:id
  http.get(`${API_BASE}/api/governance/proposals/:id`, ({ params }) => {
    const { id } = params;
    const proposal = mockProposals.find((p) => p.id === id);
    if (!proposal) {
      return HttpResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }
    return HttpResponse.json(proposal);
  }),

  // POST /api/governance/proposals/:id/vote
  http.post(`${API_BASE}/api/governance/proposals/:id/vote`, async ({ params, request }) => {
    const id = params.id as string;
    const body = (await request.json()) as { voter: string; vote: string };

    const proposal = mockProposals.find((p) => p.id === id);
    if (!proposal) {
      return HttpResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }
    if (proposal.status !== 'Active') {
      return HttpResponse.json({ error: 'Proposal is not active' }, { status: 400 });
    }

    if (!governanceVotes[id]) governanceVotes[id] = [];
    if (governanceVotes[id].includes(body.voter)) {
      return HttpResponse.json({ error: 'Already voted on this proposal' }, { status: 409 });
    }

    governanceVotes[id].push(body.voter);
    return HttpResponse.json(proposal);
  }),
];

export function resetGovernanceVotes() {
  governanceVotes = {};
}

/**
 * MSW server for Node (used in Jest tests)
 */
export const server = setupServer(...handlers, ...governanceHandlers);

/**
 * Test market with 'open' status for polling tests
 */
export const openMarket: Market = {
  ...mockMarkets[0],
  status: 'open',
};

/**
 * Test market with 'locked' status
 */
export const lockedMarket: Market = {
  ...mockMarkets[0],
  status: 'locked',
};

/**
 * Test market with 'resolved' status
 */
export const resolvedMarket: Market = {
  ...mockMarkets[1],
  status: 'resolved',
};
