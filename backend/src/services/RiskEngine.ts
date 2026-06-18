// ============================================================
// BOXMEOUT — RiskEngine
//
// Worst-case payout scenario this engine protects against:
//   If 95 % of the total pool is on Fighter A and Fighter A wins,
//   the platform must pay (total_pool / pool_a) × each A-bet.
//   When pool_a = 0.95 × total_pool that multiplier is ≈ 1.05×,
//   but the fee collected is fee_bps / 10_000 of total_pool.
//   At 2 % fee and 100 000 XLM total pool, fees collected = 2 000 XLM.
//   Payout to Fighter-A winners = 98 000 XLM from a 95 000 XLM pool,
//   meaning the platform must cover 3 000 XLM from its treasury —
//   a solvency breach. Above 95 % imbalance the deficit grows without
//   bound. The engine auto-locks before that threshold is crossed.
// ============================================================

import * as Sentry from '@sentry/node';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { pool } from '../config/db';
import { invokeContract } from './StellarService';
import { sendEmail } from './email.service';
import { logger } from '../utils/logger';
import { onBetPlaced, offBetPlaced } from '../websocket/realtime';
import {
  recordBreaker,
  getUnresolvedBreaker,
  getRecentBreakers,
  type CircuitBreakerRow,
} from '../repositories/circuit-breaker.repository';

// ---------------------------------------------------------------------------
// Runtime-configurable thresholds (read from env on every evaluation so they
// can be changed without restarting the server via env-var injection tools).
// ---------------------------------------------------------------------------
const STROOPS_PER_XLM = 10_000_000;

function maxImbalanceRatio(): number {
  return parseFloat(process.env.MAX_IMBALANCE_RATIO ?? '0.90');
}
function criticalImbalanceRatio(): number {
  return parseFloat(process.env.CRITICAL_IMBALANCE_RATIO ?? '0.95');
}
function maxMarketPoolXlm(): number {
  return parseFloat(process.env.MAX_MARKET_POOL_XLM ?? '100000');
}
function maxPlatformExposureXlm(): number {
  return parseFloat(process.env.MAX_PLATFORM_EXPOSURE_XLM ?? '500000');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface RiskAssessment {
  imbalance_ratio: number;
  absolute_breach: boolean;
  action: 'none' | 'warn' | 'lock' | 'cap';
}

interface MarketRow {
  market_id: string;
  contract_address: string;
  fighter_a: string;
  fighter_b: string;
  status: string;
  pool_a: string | null;
  pool_b: string | null;
  total_pool: string | null;
}

export interface ExposureMarket {
  market_id: string;
  fighter_a: string;
  fighter_b: string;
  pool_a_xlm: number;
  pool_b_xlm: number;
  total_pool_xlm: number;
  imbalance_ratio: number;
  status: string;
}

export interface ExposureReport {
  markets: ExposureMarket[];
  platform_total_exposure_xlm: number;
  circuit_breaker_events: CircuitBreakerRow[];
}

// ---------------------------------------------------------------------------
// RiskEngine
// ---------------------------------------------------------------------------
export class RiskEngine {
  private running = false;
  private betHandler: ((marketId: string) => void) | null = null;

  /** Attach to the internal BetPlaced bus and begin evaluating risk on each bet. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.betHandler = (marketId: string) => {
      // Use setImmediate so we never block the Express event loop that processed the bet.
      setImmediate(() => { void this.handleBetPlaced(marketId); });
    };
    onBetPlaced(this.betHandler);
    logger.info('RiskEngine started — listening for BetPlaced events');
  }

  /** Detach from the bus and cease evaluations. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.betHandler) {
      offBetPlaced(this.betHandler);
      this.betHandler = null;
    }
    logger.info('RiskEngine stopped');
  }

  // -------------------------------------------------------------------------
  // Core risk calculation — pure, synchronous, testable
  // -------------------------------------------------------------------------

  /**
   * Calculate risk metrics for a market.
   * pool_a / pool_b are expected in stroops (raw on-chain units).
   * Returns imbalance_ratio, whether the absolute pool cap is breached,
   * and the recommended action.
   */
  evaluateMarketRisk(market: { pool_a: string | null; pool_b: string | null }): RiskAssessment {
    const poolA = parseFloat(market.pool_a ?? '0');
    const poolB = parseFloat(market.pool_b ?? '0');
    const totalPool = poolA + poolB;

    if (totalPool === 0) {
      return { imbalance_ratio: 0.5, absolute_breach: false, action: 'none' };
    }

    const imbalanceRatio = Math.max(poolA, poolB) / totalPool;
    const totalPoolXlm = totalPool / STROOPS_PER_XLM;
    const absoluteBreach = totalPoolXlm >= maxMarketPoolXlm();

    let action: RiskAssessment['action'] = 'none';
    if (absoluteBreach) {
      action = 'cap';
    } else if (imbalanceRatio >= criticalImbalanceRatio()) {
      action = 'lock';
    } else if (imbalanceRatio >= maxImbalanceRatio()) {
      action = 'warn';
    }

    return { imbalance_ratio: imbalanceRatio, absolute_breach: absoluteBreach, action };
  }

  // -------------------------------------------------------------------------
  // Internal event handlers
  // -------------------------------------------------------------------------

  private async handleBetPlaced(marketId: string): Promise<void> {
    try {
      const result = await pool.query<MarketRow>(
        `SELECT market_id, contract_address, fighter_a, fighter_b, status, pool_a, pool_b, total_pool
         FROM markets WHERE market_id = $1`,
        [marketId],
      );
      const market = result.rows[0];
      if (!market || market.status !== 'open') return;

      const assessment = this.evaluateMarketRisk(market);
      if (assessment.action === 'none') return;

      await this.processAssessment(market, assessment);
    } catch (err) {
      logger.error({ err, marketId }, 'RiskEngine: error evaluating market risk');
    }
  }

  private async processAssessment(market: MarketRow, assessment: RiskAssessment): Promise<void> {
    const { imbalance_ratio, action } = assessment;
    const poolA = parseFloat(market.pool_a ?? '0');
    const poolB = parseFloat(market.pool_b ?? '0');
    const totalPoolXlm = (poolA + poolB) / STROOPS_PER_XLM;
    const adminEmail = process.env.ADMIN_EMAIL ?? '';

    // Always check platform-wide exposure first (advisory, does not gate the market action below).
    await this.checkPlatformExposure(adminEmail);

    if (action === 'warn') {
      const existing = await getUnresolvedBreaker(market.market_id, 'warn');
      if (existing) return;

      await recordBreaker({
        market_id: market.market_id,
        trigger_type: 'warn',
        imbalance_ratio,
        total_pool_xlm: totalPoolXlm,
      });

      Sentry.captureMessage(
        `[RiskEngine] Imbalance warning on market ${market.market_id}: ` +
        `${(imbalance_ratio * 100).toFixed(1)}% (${market.fighter_a} vs ${market.fighter_b})`,
        { level: 'warning' },
      );

      if (adminEmail) {
        void sendEmail(adminEmail, 'market_resolved', {
          marketTitle: `Risk Warning — ${market.fighter_a} vs ${market.fighter_b}`,
          outcome: `Pool imbalance at ${(imbalance_ratio * 100).toFixed(1)}% (${totalPoolXlm.toFixed(2)} XLM total). ` +
            `Warning threshold: ${(maxImbalanceRatio() * 100).toFixed(0)}%. Approaching auto-lock.`,
        });
      }
      return;
    }

    if (action === 'lock' || action === 'cap') {
      const existing = await getUnresolvedBreaker(market.market_id, action);
      if (existing) return;

      // 1. Update DB immediately — blocks new bets at the application layer.
      await pool.query(
        `UPDATE markets SET status = 'locked', updated_at = NOW() WHERE market_id = $1`,
        [market.market_id],
      );

      // 2. Record the circuit breaker event.
      await recordBreaker({
        market_id: market.market_id,
        trigger_type: action,
        imbalance_ratio,
        total_pool_xlm: totalPoolXlm,
      });

      // 3. Call Stellar contract asynchronously — invokeContract polls for up to 30 s
      //    and must not block the event loop.
      setImmediate(() => { void this.lockMarketOnChain(market); });

      // 4. Alert operators.
      Sentry.captureMessage(
        `[RiskEngine] AUTO-LOCK on market ${market.market_id} (${action}): ` +
        `${(imbalance_ratio * 100).toFixed(1)}% imbalance, ${totalPoolXlm.toFixed(2)} XLM pool ` +
        `(${market.fighter_a} vs ${market.fighter_b})`,
        { level: 'fatal' },
      );

      if (adminEmail) {
        void sendEmail(adminEmail, 'market_resolved', {
          marketTitle: `AUTO-LOCK — ${market.fighter_a} vs ${market.fighter_b}`,
          outcome: `Market auto-locked by risk engine (trigger: ${action}). ` +
            `Imbalance: ${(imbalance_ratio * 100).toFixed(1)}%. ` +
            `Total pool: ${totalPoolXlm.toFixed(2)} XLM. ` +
            `Critical threshold: ${(criticalImbalanceRatio() * 100).toFixed(0)}%.`,
        });
      }
    }
  }

  private async lockMarketOnChain(market: MarketRow): Promise<void> {
    try {
      const marketIdScVal = nativeToScVal(BigInt(market.market_id), { type: 'u64' });
      await invokeContract(market.contract_address, 'lock_market', [marketIdScVal]);
      logger.info({ marketId: market.market_id }, 'RiskEngine: market locked on-chain');
    } catch (err) {
      logger.error({ err, marketId: market.market_id }, 'RiskEngine: on-chain lock failed (DB already updated)');
    }
  }

  private async checkPlatformExposure(adminEmail: string): Promise<void> {
    try {
      const result = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(total_pool), 0)::text AS total FROM markets WHERE status = 'open'`,
      );
      const totalPool = parseFloat(result.rows[0]?.total ?? '0');
      const totalExposureXlm = totalPool / STROOPS_PER_XLM;

      if (totalExposureXlm < maxPlatformExposureXlm()) return;

      const existing = await getUnresolvedBreaker('platform', 'platform_exposure');
      if (existing) return;

      await recordBreaker({
        market_id: 'platform',
        trigger_type: 'platform_exposure',
        imbalance_ratio: 0,
        total_pool_xlm: totalExposureXlm,
      });

      Sentry.captureMessage(
        `[RiskEngine] Platform exposure limit reached: ${totalExposureXlm.toFixed(0)} XLM ` +
        `(limit: ${maxPlatformExposureXlm()} XLM). New market creation must be paused.`,
        { level: 'fatal' },
      );

      if (adminEmail) {
        void sendEmail(adminEmail, 'market_resolved', {
          marketTitle: 'Platform Exposure Alert',
          outcome: `Platform total open pool: ${totalExposureXlm.toFixed(0)} XLM exceeds ` +
            `the ${maxPlatformExposureXlm()} XLM limit. New market creation is paused.`,
        });
      }
    } catch (err) {
      logger.error({ err }, 'RiskEngine: error checking platform exposure');
    }
  }

  // -------------------------------------------------------------------------
  // Admin exposure report (cached at route layer)
  // -------------------------------------------------------------------------

  async getExposureReport(): Promise<ExposureReport> {
    const [marketsResult, recentBreakers] = await Promise.all([
      pool.query<MarketRow & { fighter_a: string; fighter_b: string }>(
        `SELECT market_id, contract_address, fighter_a, fighter_b, status, pool_a, pool_b, total_pool
         FROM markets WHERE status = 'open' ORDER BY total_pool DESC NULLS LAST`,
      ),
      getRecentBreakers(10),
    ]);

    const markets: ExposureMarket[] = marketsResult.rows.map((m) => {
      const poolAXlm = parseFloat(m.pool_a ?? '0') / STROOPS_PER_XLM;
      const poolBXlm = parseFloat(m.pool_b ?? '0') / STROOPS_PER_XLM;
      const totalPoolXlm = poolAXlm + poolBXlm;
      const imbalanceRatio = totalPoolXlm === 0
        ? 0.5
        : Math.max(poolAXlm, poolBXlm) / totalPoolXlm;

      return {
        market_id: m.market_id,
        fighter_a: m.fighter_a,
        fighter_b: m.fighter_b,
        pool_a_xlm: poolAXlm,
        pool_b_xlm: poolBXlm,
        total_pool_xlm: totalPoolXlm,
        imbalance_ratio: imbalanceRatio,
        status: m.status,
      };
    });

    const platformTotalExposureXlm = markets.reduce((sum, m) => sum + m.total_pool_xlm, 0);

    return { markets, platform_total_exposure_xlm: platformTotalExposureXlm, circuit_breaker_events: recentBreakers };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------
let _engine: RiskEngine | null = null;

export function getRiskEngine(): RiskEngine {
  if (!_engine) _engine = new RiskEngine();
  return _engine;
}
