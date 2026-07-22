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

// Utility: spread typed props into a plain record for the track() call
function props<T extends object>(p: T): Record<string, unknown> {
  return p as unknown as Record<string, unknown>;
}

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

export function trackWalletConnected(p: WalletEventProps): void {
  track('wallet_connected', props(p));
}

export function trackWalletDisconnected(p: Pick<WalletEventProps, 'hashed_address'>): void {
  track('wallet_disconnected', props(p));
}

export function trackWalletConnectionFailed(p: { error: string; wallet_provider: string }): void {
  track('wallet_connection_failed', props(p));
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

export function trackMarketViewed(p: MarketViewedProps): void {
  track('market_viewed', props(p));
}

export function trackMarketsFiltered(p: {
  weight_class?: string;
  status?: string;
  sort?: string;
  result_count: number;
}): void {
  track('markets_filtered', props(p));
}

// ─── Bet funnel ──────────────────────────────────────────────────────────────

export interface BetFunnelBaseProps {
  market_id: string;
  fighter_a: string;
  fighter_b: string;
  weight_class: string;
}

/** Step 1 — user selects a side on the bet panel. */
export function trackBetSideSelected(p: BetFunnelBaseProps & { side: BetSide }): void {
  track('bet_side_selected', props(p));
}

/** Step 2 — user enters an amount. */
export function trackBetAmountEntered(p: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
  estimated_payout_xlm: number;
}): void {
  track('bet_amount_entered', props(p));
}

/** Step 3 — user opens the confirmation modal. */
export function trackBetConfirmOpened(p: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
  estimated_payout_xlm: number;
  fee_bps: number;
}): void {
  track('bet_confirm_opened', props(p));
}

/** Step 4 — user cancels from the confirmation modal. */
export function trackBetConfirmCancelled(p: BetFunnelBaseProps & { side: BetSide }): void {
  track('bet_confirm_cancelled', props(p));
}

/** Step 5a — transaction signing started (wallet prompt shown). */
export function trackBetSigningStarted(p: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
}): void {
  track('bet_signing_started', props(p));
}

/** Step 5b — transaction confirmed on-chain. */
export function trackBetPlaced(p: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
  estimated_payout_xlm: number;
  tx_hash: string;
  fee_bps: number;
}): void {
  track('bet_placed', props(p));
}

/** Step 5c — transaction failed at any stage. */
export function trackBetFailed(p: BetFunnelBaseProps & {
  side: BetSide;
  amount_xlm: number;
  error: string;
  stage: 'signing' | 'broadcasting' | 'confirming';
}): void {
  track('bet_failed', props(p));
}

// ─── Settlement / claim ───────────────────────────────────────────────────────

export interface ClaimEventBaseProps {
  market_id: string;
  fighter_a: string;
  fighter_b: string;
  projected_payout_xlm: number | null;
}

/** User initiates a claim from the ClaimWinningsPanel. */
export function trackClaimInitiated(p: ClaimEventBaseProps): void {
  track('claim_initiated', props(p));
}

/** Claim transaction confirmed on-chain — settlement complete. */
export function trackClaimSuccess(p: ClaimEventBaseProps & { tx_hash: string }): void {
  track('claim_success', props(p));
}

/** Claim transaction failed. */
export function trackClaimFailed(p: ClaimEventBaseProps & { error: string }): void {
  track('claim_failed', props(p));
}

/** User clicks "Claim All" on the portfolio page. */
export function trackClaimAllInitiated(p: { market_count: number }): void {
  track('claim_all_initiated', props(p));
}

// ─── Portfolio / retention ───────────────────────────────────────────────────

export function trackPortfolioViewed(p: {
  total_bets: number;
  active_bets: number;
  pending_claims: number;
  total_staked_xlm: number;
  total_won_xlm: number;
  total_lost_xlm: number;
}): void {
  track('portfolio_viewed', props(p));
}

// ─── Governance (bonus funnel) ────────────────────────────────────────────────

export function trackProposalViewed(p: { proposal_id: string; proposal_type: string }): void {
  track('proposal_viewed', props(p));
}

export function trackVoteSubmitted(p: {
  proposal_id: string;
  proposal_type: string;
  vote: 'for' | 'against' | 'abstain';
}): void {
  track('vote_submitted', props(p));
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export function trackError(p: { context: string; error: string; fatal?: boolean }): void {
  track('error_occurred', { fatal: false, ...props(p) });
}
