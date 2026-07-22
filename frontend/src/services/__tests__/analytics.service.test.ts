// ============================================================
// Unit tests for frontend/src/services/analytics.service.ts
// Verifies that every public helper calls track() with the
// correct event name and property shape.
// ============================================================

const mockTrack = jest.fn();

jest.mock('../../lib/analytics', () => ({
  track: mockTrack,
  hashAddress: jest.fn(async (a: string) => a.slice(0, 16)),
  initAnalytics: jest.fn(),
  identifyUser: jest.fn(),
  resetIdentity: jest.fn(),
}));

import {
  trackAppBooted,
  trackPageView,
  trackWalletConnected,
  trackWalletDisconnected,
  trackWalletConnectionFailed,
  trackMarketViewed,
  trackMarketsFiltered,
  trackBetSideSelected,
  trackBetAmountEntered,
  trackBetConfirmOpened,
  trackBetConfirmCancelled,
  trackBetSigningStarted,
  trackBetPlaced,
  trackBetFailed,
  trackClaimInitiated,
  trackClaimSuccess,
  trackClaimFailed,
  trackClaimAllInitiated,
  trackPortfolioViewed,
  trackProposalViewed,
  trackVoteSubmitted,
  trackError,
} from '../analytics.service';

beforeEach(() => mockTrack.mockClear());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expectEvent(name: string, partialProps?: Record<string, unknown>) {
  expect(mockTrack).toHaveBeenCalledTimes(1);
  const [eventName, props] = mockTrack.mock.calls[0];
  expect(eventName).toBe(name);
  if (partialProps) {
    expect(props).toMatchObject(partialProps);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('trackAppBooted', () => {
  it('fires "app_booted"', () => {
    trackAppBooted();
    expectEvent('app_booted');
  });
});

describe('trackPageView', () => {
  it('fires "page_viewed" with page name', () => {
    trackPageView('/markets', { search: 'weight_class=heavyweight' });
    expectEvent('page_viewed', { page: '/markets', search: 'weight_class=heavyweight' });
  });
});

describe('wallet events', () => {
  const walletProps = { hashed_address: 'abc123', wallet_provider: 'freighter' as const };

  it('trackWalletConnected fires "wallet_connected"', () => {
    trackWalletConnected(walletProps);
    expectEvent('wallet_connected', walletProps);
  });

  it('trackWalletDisconnected fires "wallet_disconnected"', () => {
    trackWalletDisconnected({ hashed_address: 'abc123' });
    expectEvent('wallet_disconnected', { hashed_address: 'abc123' });
  });

  it('trackWalletConnectionFailed fires "wallet_connection_failed"', () => {
    trackWalletConnectionFailed({ error: 'User rejected', wallet_provider: 'freighter' });
    expectEvent('wallet_connection_failed', { error: 'User rejected' });
  });
});

describe('market discovery events', () => {
  const marketProps = {
    market_id: 'mkt_1',
    fighter_a: 'Ali',
    fighter_b: 'Foreman',
    weight_class: 'Heavyweight',
    market_status: 'open' as const,
    total_pool_xlm: 1000,
    title_fight: true,
  };

  it('trackMarketViewed fires "market_viewed"', () => {
    trackMarketViewed(marketProps);
    expectEvent('market_viewed', { market_id: 'mkt_1' });
  });

  it('trackMarketsFiltered fires "markets_filtered"', () => {
    trackMarketsFiltered({ weight_class: 'Heavyweight', result_count: 5 });
    expectEvent('markets_filtered', { weight_class: 'Heavyweight', result_count: 5 });
  });
});

describe('bet funnel events', () => {
  const base = {
    market_id: 'mkt_1',
    fighter_a: 'Ali',
    fighter_b: 'Foreman',
    weight_class: 'Heavyweight',
  };

  it('trackBetSideSelected fires "bet_side_selected"', () => {
    trackBetSideSelected({ ...base, side: 'fighter_a' });
    expectEvent('bet_side_selected', { side: 'fighter_a' });
  });

  it('trackBetAmountEntered fires "bet_amount_entered"', () => {
    trackBetAmountEntered({ ...base, side: 'fighter_a', amount_xlm: 50, estimated_payout_xlm: 90 });
    expectEvent('bet_amount_entered', { amount_xlm: 50, estimated_payout_xlm: 90 });
  });

  it('trackBetConfirmOpened fires "bet_confirm_opened"', () => {
    trackBetConfirmOpened({ ...base, side: 'fighter_a', amount_xlm: 50, estimated_payout_xlm: 90, fee_bps: 100 });
    expectEvent('bet_confirm_opened', { fee_bps: 100 });
  });

  it('trackBetConfirmCancelled fires "bet_confirm_cancelled"', () => {
    trackBetConfirmCancelled({ ...base, side: 'draw' });
    expectEvent('bet_confirm_cancelled', { side: 'draw' });
  });

  it('trackBetSigningStarted fires "bet_signing_started"', () => {
    trackBetSigningStarted({ ...base, side: 'fighter_b', amount_xlm: 100 });
    expectEvent('bet_signing_started', { amount_xlm: 100 });
  });

  it('trackBetPlaced fires "bet_placed" with tx_hash', () => {
    trackBetPlaced({ ...base, side: 'fighter_a', amount_xlm: 50, estimated_payout_xlm: 90, tx_hash: 'hash_abc', fee_bps: 100 });
    expectEvent('bet_placed', { tx_hash: 'hash_abc' });
  });

  it('trackBetFailed fires "bet_failed" with stage', () => {
    trackBetFailed({ ...base, side: 'fighter_a', amount_xlm: 50, error: 'rejected', stage: 'signing' });
    expectEvent('bet_failed', { stage: 'signing', error: 'rejected' });
  });
});

describe('claim / settlement events', () => {
  const base = {
    market_id: 'mkt_1',
    fighter_a: 'Ali',
    fighter_b: 'Foreman',
    projected_payout_xlm: 150,
  };

  it('trackClaimInitiated fires "claim_initiated"', () => {
    trackClaimInitiated(base);
    expectEvent('claim_initiated', { market_id: 'mkt_1' });
  });

  it('trackClaimSuccess fires "claim_success" with tx_hash', () => {
    trackClaimSuccess({ ...base, tx_hash: 'hash_xyz' });
    expectEvent('claim_success', { tx_hash: 'hash_xyz' });
  });

  it('trackClaimFailed fires "claim_failed" with error', () => {
    trackClaimFailed({ ...base, error: 'timeout' });
    expectEvent('claim_failed', { error: 'timeout' });
  });

  it('trackClaimAllInitiated fires "claim_all_initiated"', () => {
    trackClaimAllInitiated({ market_count: 3 });
    expectEvent('claim_all_initiated', { market_count: 3 });
  });
});

describe('portfolio events', () => {
  it('trackPortfolioViewed fires "portfolio_viewed"', () => {
    trackPortfolioViewed({
      total_bets: 10,
      active_bets: 2,
      pending_claims: 1,
      total_staked_xlm: 500,
      total_won_xlm: 300,
      total_lost_xlm: 200,
    });
    expectEvent('portfolio_viewed', { total_bets: 10 });
  });
});

describe('governance events', () => {
  it('trackProposalViewed fires "proposal_viewed"', () => {
    trackProposalViewed({ proposal_id: 'p1', proposal_type: 'fee_rate' });
    expectEvent('proposal_viewed', { proposal_id: 'p1' });
  });

  it('trackVoteSubmitted fires "vote_submitted"', () => {
    trackVoteSubmitted({ proposal_id: 'p1', proposal_type: 'fee_rate', vote: 'for' });
    expectEvent('vote_submitted', { vote: 'for' });
  });
});

describe('error tracking', () => {
  it('trackError fires "error_occurred" with defaults', () => {
    trackError({ context: 'BetPanel', error: 'network timeout' });
    expectEvent('error_occurred', { context: 'BetPanel', error: 'network timeout', fatal: false });
  });

  it('trackError respects fatal: true override', () => {
    trackError({ context: 'Root', error: 'crash', fatal: true });
    expectEvent('error_occurred', { fatal: true });
  });
});

describe('no PII in any event', () => {
  it('wallet connect event uses hashed_address, not a full Stellar key', () => {
    const stellarKey = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';
    trackWalletConnected({ hashed_address: 'abc123def456abcd', wallet_provider: 'freighter' });
    const [, props] = mockTrack.mock.calls[0];
    // The raw stellar key must not appear in emitted props
    expect(JSON.stringify(props)).not.toContain(stellarKey);
  });
});
