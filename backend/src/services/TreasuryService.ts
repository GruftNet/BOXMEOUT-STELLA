import { logger } from '../utils/logger';
import { StellarService } from './StellarService';
import { TreasurySweepRepository } from '../repositories/TreasurySweepRepository';
import * as Sentry from '@sentry/node';
import { env } from '../config/env';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // 1s, 2s, 4s in milliseconds

interface SweepResult {
  success: boolean;
  txHash?: string;
  amountXlm: number;
  error?: string;
}

export class TreasuryService {
  constructor(
    private stellarService: StellarService,
    private treasurySweepRepository: TreasurySweepRepository
  ) {}

  /**
   * Fetch the current on-chain Treasury balance
   * @returns Balance in stroops
   */
  async getTreasuryBalance(): Promise<number> {
    try {
      logger.info('Fetching Treasury balance from on-chain contract');
      
      const balance = await this.stellarService.invokeContract({
        contractId: env.TREASURY_CONTRACT_ID,
        method: 'get_balance',
        args: [],
      });

      logger.info(`Treasury balance fetched: ${balance} stroops`);
      return balance;
    } catch (error) {
      logger.error('Failed to fetch Treasury balance', { error });
      throw error;
    }
  }

  /**
   * Execute a Treasury sweep with retry logic
   * @param toAddress Destination wallet address
   * @param amountStroops Amount to withdraw in stroops
   * @returns SweepResult containing tx_hash or error details
   */
  async sweepTreasury(
    toAddress: string,
    amountStroops: number
  ): Promise<SweepResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info(
          `Sweep attempt ${attempt}/${MAX_RETRIES}: withdrawing ${amountStroops} stroops to ${toAddress}`
        );

        const txHash = await this.stellarService.invokeContract({
          contractId: env.TREASURY_CONTRACT_ID,
          method: 'withdraw',
          args: [toAddress, amountStroops.toString()],
        });

        const amountXlm = this.stroopsToXlm(amountStroops);

        // Record successful sweep in DB
        await this.treasurySweepRepository.recordSweep({
          amount_xlm: amountXlm,
          amount_stroops: amountStroops,
          tx_hash: txHash,
          to_address: toAddress,
          status: 'success',
        });

        logger.info(
          `Sweep successful on attempt ${attempt}: tx_hash=${txHash}, amount=${amountXlm} XLM`
        );

        return {
          success: true,
          txHash,
          amountXlm,
        };
      } catch (error) {
        lastError = error as Error;
        logger.warn(
          `Sweep attempt ${attempt}/${MAX_RETRIES} failed: ${(error as Error).message}`
        );

        if (attempt < MAX_RETRIES) {
          const delayMs = RETRY_DELAYS[attempt - 1];
          logger.info(`Retrying in ${delayMs}ms...`);
          await this.delay(delayMs);
        }
      }
    }

    // All retries exhausted
    const amountXlm = this.stroopsToXlm(amountStroops);

    // Record failed sweep in DB
    await this.treasurySweepRepository.recordSweep({
      amount_xlm: amountXlm,
      amount_stroops: amountStroops,
      tx_hash: null,
      to_address: toAddress,
      status: 'failed',
    });

    // Alert via Sentry
    Sentry.captureException(
      new Error(
        `Treasury sweep failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
      ),
      {
        tags: {
          service: 'treasury',
          operation: 'sweep',
        },
        contexts: {
          treasury: {
            amountXlm,
            toAddress,
            attempts: MAX_RETRIES,
          },
        },
      }
    );

    logger.error(
      `Sweep failed after ${MAX_RETRIES} attempts`,
      {
        amountXlm,
        toAddress,
        lastError: lastError?.message,
      }
    );

    return {
      success: false,
      amountXlm,
      error: lastError?.message || 'Unknown error',
    };
  }

  /**
   * Execute a full sweep cycle if balance exceeds threshold
   */
  async executeSweepCycle(): Promise<void> {
    try {
      const balanceStroops = await this.getTreasuryBalance();
      const thresholdStroops = this.xlmToStroops(env.TREASURY_SWEEP_THRESHOLD_XLM);

      logger.info(
        `Treasury sweep cycle: balance=${balanceStroops} stroops, threshold=${thresholdStroops} stroops`
      );

      if (balanceStroops < thresholdStroops) {
        logger.info(
          `Balance below threshold (${this.stroopsToXlm(balanceStroops)} XLM < ${env.TREASURY_SWEEP_THRESHOLD_XLM} XLM). Skipping sweep.`
        );
        return;
      }

      // Check for existing pending sweep with same tx_hash to avoid duplicates
      const existingPendingSweep = await this.treasurySweepRepository.findLatestBySweepDate(
        new Date(Date.now() - 60000) // Last 1 minute
      );

      if (existingPendingSweep && existingPendingSweep.status === 'success') {
        logger.info(
          `Recent successful sweep detected (${existingPendingSweep.tx_hash}). Skipping to prevent duplicates.`
        );
        return;
      }

      // Execute sweep
      const result = await this.sweepTreasury(
        env.TREASURY_WALLET_ADDRESS,
        balanceStroops
      );

      if (result.success) {
        logger.info(
          `Sweep cycle completed successfully: ${result.amountXlm} XLM transferred`
        );
      } else {
        logger.error(`Sweep cycle failed: ${result.error}`);
      }
    } catch (error) {
      logger.error('Treasury sweep cycle failed', { error });
      Sentry.captureException(error, {
        tags: { service: 'treasury', operation: 'sweep_cycle' },
      });
    }
  }

  // Utility methods
  private stroopsToXlm(stroops: number): number {
    return stroops / 10_000_000;
  }

  private xlmToStroops(xlm: number): number {
    return Math.floor(xlm * 10_000_000);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
