import type { Bet } from '../models/Bet';
import type { Market, MarketStats } from '../models/Market';
import type { MarketOdds, Portfolio } from '../services/MarketService';

export interface GqlPosition {
  id: string;
  marketId: string;
  ownerAddress: string;
  side: Bet['side'];
  totalAmount: string;
  totalAmountXlm: number;
  betCount: number;
}

export interface GqlTrade {
  id: string;
  marketId: string;
  traderAddress: string;
  side: Bet['side'];
  amount: string;
  amountXlm: number;
  priceBps: number | null;
  executedAt: string;
  txHash: string;
}

export function mapMarket(market: Market) {
  return {
    id: String(market.id),
    marketId: market.market_id,
    market_id: market.market_id,
    contractAddress: market.contract_address,
    matchId: market.match_id,
    fighterA: market.fighter_a,
    fighterB: market.fighter_b,
    weightClass: market.weight_class,
    titleFight: market.title_fight,
    venue: market.venue,
    scheduledAt: toIso(market.scheduled_at),
    status: market.status,
    outcome: market.outcome,
    poolA: market.pool_a,
    poolB: market.pool_b,
    poolDraw: market.pool_draw,
    totalPool: market.total_pool,
    feeBps: market.fee_bps,
    lockBeforeSecs: market.lock_before_secs,
    resolvedAt: market.resolved_at ? toIso(market.resolved_at) : null,
    oracleUsed: market.oracle_used,
    createdAt: toIso(market.created_at),
    updatedAt: toIso(market.updated_at),
    ledgerSequence: market.ledger_sequence,
    _raw: market,
  };
}

export function mapOdds(odds: MarketOdds) {
  return {
    oddsA: odds.odds_a,
    oddsB: odds.odds_b,
    oddsDraw: odds.odds_draw,
    odds_a: odds.odds_a,
    odds_b: odds.odds_b,
    odds_draw: odds.odds_draw,
  };
}

export function mapBet(bet: Bet) {
  return {
    id: String(bet.id),
    marketId: bet.market_id,
    bettorAddress: bet.bettor_address,
    side: bet.side,
    amount: bet.amount,
    amountXlm: bet.amount_xlm,
    placedAt: toIso(bet.placed_at),
    claimed: bet.claimed,
    claimedAt: bet.claimed_at ? toIso(bet.claimed_at) : null,
    payout: bet.payout,
    txHash: bet.tx_hash,
    ledgerSequence: bet.ledger_sequence,
    _raw: bet,
  };
}

export function mapStats(stats: MarketStats) {
  return {
    marketId: stats.market_id,
    totalBets: stats.total_bets,
    uniqueBettors: stats.unique_bettors,
    largestBetXlm: stats.largest_bet_xlm,
    averageBetXlm: stats.average_bet_xlm,
    totalPooledXlm: stats.total_pooled_xlm,
  };
}

export function mapPortfolio(portfolio: Portfolio) {
  return {
    address: portfolio.address,
    activeBets: portfolio.active_bets.map(mapBet),
    pastBets: portfolio.past_bets.map(mapBet),
    pendingClaims: portfolio.pending_claims.map(mapBet),
    totalStakedXlm: portfolio.total_staked_xlm,
    totalWonXlm: portfolio.total_won_xlm,
    totalLostXlm: portfolio.total_lost_xlm,
  };
}

export function betToTrade(bet: Bet, priceBps: number | null = null): GqlTrade {
  return {
    id: `trade:${bet.id}`,
    marketId: bet.market_id,
    traderAddress: bet.bettor_address,
    side: bet.side,
    amount: bet.amount,
    amountXlm: bet.amount_xlm,
    priceBps,
    executedAt: toIso(bet.placed_at),
    txHash: bet.tx_hash,
  };
}

export function aggregatePositions(bets: Bet[]): GqlPosition[] {
  const map = new Map<string, GqlPosition>();

  for (const bet of bets) {
    const key = `${bet.market_id}:${bet.bettor_address}:${bet.side}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        id: `pos:${key}`,
        marketId: bet.market_id,
        ownerAddress: bet.bettor_address,
        side: bet.side,
        totalAmount: bet.amount,
        totalAmountXlm: bet.amount_xlm,
        betCount: 1,
      });
      continue;
    }

    existing.totalAmount = addDecimalStrings(existing.totalAmount, bet.amount);
    existing.totalAmountXlm += bet.amount_xlm;
    existing.betCount += 1;
  }

  return [...map.values()];
}

function addDecimalStrings(a: string, b: string): string {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return String(Number(a) + Number(b));
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
