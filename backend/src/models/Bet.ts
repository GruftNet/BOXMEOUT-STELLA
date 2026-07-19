// ============================================================
// BOXMEOUT — Bet Database Model
// ============================================================

export interface Bet {
  id: number;
  /** Foreign key to markets.market_id */
  market_id: string;
  /** Stellar G... address of the bettor */
  bettor_address: string;
  side: BetSideDB;
  /** Amount in stroops as string (i128 precision) */
  amount: string;
  /** Denormalized XLM amount for display queries */
  amount_xlm: number;
  placed_at: Date;
  claimed: boolean;
  claimed_at: Date | null;
  /** Actual payout received, null until claimed */
  payout: string | null;
  /** Stellar transaction hash for the place_bet call */
  tx_hash: string;
  ledger_sequence: number;
}

export type BetSideDB = 'fighter_a' | 'fighter_b' | 'draw';
