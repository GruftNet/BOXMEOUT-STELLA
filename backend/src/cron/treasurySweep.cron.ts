import cron from 'node-cron';
import { logger } from '../utils/logger';
import { TreasuryService } from '../services/TreasuryService';

let dailyCronTask: cron.ScheduledTask | null = null;
let thresholdIntervalTask: NodeJS.Timeout | null = null;

/**
 * Register the Treasury sweep cron jobs
 * 1. Daily sweep at 02:00 UTC via node-cron
 * 2. Balance check every 10 minutes with threshold-based trigger
 */
export function registerTreasurySweepCrons(treasuryService: TreasuryService): void {
  // Daily cron at 02:00 UTC (cron expression: minute hour day month day-of-week)
  // 0 2 * * * = 02:00 every day
  dailyCronTask = cron.schedule('0 2 * * *', async () => {
    logger.info('Treasury sweep cron triggered: Daily scheduled sweep at 02:00 UTC');
    await treasuryService.executeSweepCycle();
  });

  logger.info('Daily Treasury sweep cron registered: 0 2 * * * (02:00 UTC)');

  // Threshold-based trigger: check balance every 10 minutes
  thresholdIntervalTask = setInterval(async () => {
    logger.debug('Checking Treasury balance for threshold-based trigger...');
    try {
      const balanceStroops = await treasuryService.getTreasuryBalance();
      const thresholdStroops = (10_000_000 * 1000); // Default 1000 XLM in stroops
      
      if (balanceStroops >= thresholdStroops) {
        logger.info(
          `Balance threshold exceeded: ${balanceStroops / 10_000_000} XLM >= 1000 XLM. Triggering sweep.`
        );
        await treasuryService.executeSweepCycle();
      }
    } catch (error) {
      logger.error('Error during threshold check', { error });
    }
  }, 10 * 60 * 1000); // 10 minutes in milliseconds

  logger.info('Treasury balance threshold check registered: every 10 minutes');
}

/**
 * Gracefully stop the Treasury sweep crons
 */
export function stopTreasurySweepCrons(): void {
  if (dailyCronTask) {
    dailyCronTask.stop();
    dailyCronTask.destroy();
    logger.info('Daily Treasury sweep cron stopped');
  }

  if (thresholdIntervalTask) {
    clearInterval(thresholdIntervalTask);
    logger.info('Treasury threshold check interval stopped');
  }
}

/**
 * Get cron status for monitoring
 */
export function getTreasurySweepCronStatus(): {
  dailyCronActive: boolean;
  thresholdCheckActive: boolean;
} {
  return {
    dailyCronActive: dailyCronTask !== null && dailyCronTask.status === 'running',
    thresholdCheckActive: thresholdIntervalTask !== null,
  };
}
