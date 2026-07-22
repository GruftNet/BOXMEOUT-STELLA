// ============================================================
// BOXMEOUT — Analytics Service
// High-level, typed event helpers for product analytics.
//
// Design principles:
//   1. ALL calls are fire-and-forget — no await needed at call sites.
//   2. No PII.  Wallet addresses are pre-hashed by callers (useAnalytics).
//   3. Property names follow snake_case for Mixpanel consistency.
//   4. Each section maps to a funnel stage in the acceptance criteria:
//        • Identity / session
//        • Page views (user journey)
//        • Wallet (connect / disconnect)
//        • Market discovery
//        • Bet funnel  (signup → bet → settlement)
//        • Settlement / claim
//        • Governance (bonus — same funnel pattern)
//        • Errors
// ============================================================

import { track } from '../lib/analytics';
import type { BetSide, MarketStatus } from '../types';

// ─── Identity / Session ──────────────────────────────────────────────────────

/** Fired once when the analytics SDK is ready (boot tracking). */
export function trackAppBooted(): void {
  track('app_booted', { referrer: typeof document !== 'undefined' ? document.referrer : '' });
}

// ─── Page views ──────────────────────────────────────────────────────────────

export function trackPageView(page: string, properties?: Record<string, unknown>): void {
  track('page_viewed', { page, ...properties });
}

// ─── Wallet events ───────────────────────────────────────────────────────────

export interface WalletEventProps {
  /** Hashed wallet address (16 hex chars of SHA-256). Never raw. */
  hashed_address: string;
  wallet_provider: 'freighter' | 'albedo' | 'unknown';
}

export function trackWalletConnected(props: WalletEventProps): void {
  track('wallet_connected', props);
}

export function trackWalletDisconnected(props: Pick<WalletEventProps, 'hashed_address'>): void {
  track('wallet_disconnected', props);
}

export function trackWalletConnectionFailed(props: { error: string; wallet_provider: string }): void {
  track('wallet_connection_failed', props);
}

// ─── Market discovery ────────────────────────────────────────────────────────

export interface MarketViewedProps {
  market_id: string;
  fighter_a: string;
  fighter_b: string;
  weight_class: string;
  market_status: MarketStatus;
  total_pool_xlm: number;
  title_fight: boolean;
}

export function trackMarketViewed(props: MarketViewedProps): void {
  track('market_viewed', props);
}

export function trackMarketsFiltered(props: {
  weight_class?: string;
  status?: string;
  sort?: string;
  result_count: number;
}): void {
  track('markets_filtered', props);
}

// ─── Bet funnel ──────────────────────────────────────────────────────────────

export interface BetFunnelBaseProps {
  market_id: string;
  fighter_a: string;
  fighter_b: string;
  weight_class: string;
}

/** Step 1 — user selects a side on the bet panel. */
export function trackBetSideSelected(props: BetFunnelBaseProps & { side: BetSide }): void {
  track('bet_side_selected', props);
}

/** Step 2 — user enters an amount. */
export function trackBetAmountEntered(props: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
  estimated_payout_xlm: number;
}): void {
  track('bet_amount_entered', props);
}

/** Step 3 — user opens the confirmation modal. */
export function trackBetConfirmOpened(props: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
  estimated_payout_xlm: number;
  fee_bps: number;
}): void {
  track('bet_confirm_opened', props);
}

/** Step 4 — user cancels from the confirmation modal. */
export function trackBetConfirmCancelled(props: BetFunnelBaseProps & { side: BetSide }): void {
  track('bet_confirm_cancelled', props);
}

/** Step 5a — transaction signing started (wallet prompt shown). */
export function trackBetSigningStarted(props: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
}): void {
  track('bet_signing_started', props);
}

/** Step 5b — transaction confirmed on-chain. */
export function trackBetPlaced(props: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
  estimated_payout_xlm: number;
  tx_hash: string;
  fee_bps: number;
}): void {
  track('bet_placed', props);
}

/** Step 5c — transaction failed at any stage. */
export function trackBetFailed(props: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
  error: string;
  stage: 'signing' | 'broadcasting' | 'confirming';
}): void {
  track('bet_failed', props);
}

// ─── Settlement / claim ───────────────────────────────────────────────────────

export interface ClaimEventBaseProps {
  market_id: string;
  fighter_a: string;
  fighter_b: string;
  projected_payout_xlm: number | null;
}

/** User initiates a claim from the ClaimWinningsPanel. */
export function trackClaimInitiated(props: ClaimEventBaseProps): void {
  track('claim_initiated', props);
}

/** Claim transaction confirmed on-chain — settlement complete. */
export function trackClaimSuccess(props: ClaimEventBaseProps & { tx_hash: string }): void {
  track('claim_success', props);
}

/** Claim transaction failed. */
export function trackClaimFailed(props: ClaimEventBaseProps & { error: string }): void {
  track('claim_failed', props);
}

/** User clicks "Claim All" on the portfolio page. */
export function trackClaimAllInitiated(props: { market_count: number }): void {
  track('claim_all_initiated', props);
}

// ─── Portfolio / retention ───────────────────────────────────────────────────

export function trackPortfolioViewed(props: {
  total_bets: number;
  active_bets: number;
  pending_claims: number;
  total_staked_xlm: number;
  total_won_xlm: number;
  total_lost_xlm: number;
}): void {
  track('portfolio_viewed', props);
}

// ─── Governance (bonus funnel) ────────────────────────────────────────────────

export function trackProposalViewed(props: { proposal_id: string; proposal_type: string }): void {
  track('proposal_viewed', props);
}

export function trackVoteSubmitted(props: {
  proposal_id: string;
  proposal_type: string;
  vote: 'for' | 'against' | 'abstain';
}): void {
  track('vote_submitted', props);
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export function trackError(props: { context: string; error: string; fatal?: boolean }): void {
  track('error_occurred', { fatal: false, ...props });
}
