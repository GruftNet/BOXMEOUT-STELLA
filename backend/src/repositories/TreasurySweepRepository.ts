import { db } from '../db/client';
import { treasurySweeps } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { logger } from '../utils/logger';

export interface TreasurySweepRecord {
  amount_xlm: number;
  amount_stroops: number;
  tx_hash: string | null;
  to_address: string;
  status: 'success' | 'failed';
}

export class TreasurySweepRepository {
  /**
   * Record a Treasury sweep event in the database
   * Ensures idempotency: if a tx_hash already exists, it will not insert a duplicate row
   */
  async recordSweep(data: TreasurySweepRecord): Promise<void> {
    try {
      // Check for existing record with same tx_hash (idempotency check)
      if (data.tx_hash) {
        const existingRecord = await db
          .select()
          .from(treasurySweeps)
          .where(eq(treasurySweeps.tx_hash, data.tx_hash))
          .limit(1);

        if (existingRecord.length > 0) {
          logger.info(
            `Treasury sweep with tx_hash ${data.tx_hash} already recorded. Skipping duplicate insertion.`
          );
          return;
        }
      }

      // Insert the sweep record
      const result = await db.insert(treasurySweeps).values({
        swept_at: new Date(),
        amount_xlm: data.amount_xlm,
        amount_stroops: data.amount_stroops,
        tx_hash: data.tx_hash,
        to_address: data.to_address,
        status: data.status,
      });

      logger.info(
        `Treasury sweep recorded: status=${data.status}, amount=${data.amount_xlm} XLM, tx_hash=${data.tx_hash || 'N/A'}`
      );
    } catch (error) {
      logger.error('Failed to record Treasury sweep', { error, data });
      throw error;
    }
  }

  /**
   * Find the latest sweep record(s) by date
   */
  async findLatestBySweepDate(afterDate: Date): Promise<any | null> {
    try {
      const results = await db
        .select()
        .from(treasurySweeps)
        .where(
          and(
            // @ts-ignore - Drizzle ORM date comparison
            treasurySweeps.swept_at >= afterDate
          )
        )
        .orderBy(desc(treasurySweeps.swept_at))
        .limit(1);

      return results.length > 0 ? results[0] : null;
    } catch (error) {
      logger.error('Failed to find latest Treasury sweep', { error });
      throw error;
    }
  }

  /**
   * Get all sweep records with optional filtering
   */
  async getAllSweeps(
    filters?: {
      status?: 'success' | 'failed';
      limit?: number;
      offset?: number;
    }
  ): Promise<any[]> {
    try {
      let query = db.select().from(treasurySweeps);

      if (filters?.status) {
        query = query.where(eq(treasurySweeps.status, filters.status));
      }

      query = query.orderBy(desc(treasurySweeps.swept_at));

      if (filters?.limit) {
        query = query.limit(filters.limit);
      }

      if (filters?.offset) {
        query = query.offset(filters.offset);
      }

      return query;
    } catch (error) {
      logger.error('Failed to retrieve Treasury sweeps', { error });
      throw error;
    }
  }

  /**
   * Get sweep statistics
   */
  async getSweepStatistics(): Promise<{
    totalSweeps: number;
    successfulSweeps: number;
    failedSweeps: number;
    totalAmountXlm: number;
  }> {
    try {
      const allSweeps = await db.select().from(treasurySweeps);

      return {
        totalSweeps: allSweeps.length,
        successfulSweeps: allSweeps.filter((s) => s.status === 'success').length,
        failedSweeps: allSweeps.filter((s) => s.status === 'failed').length,
        totalAmountXlm: allSweeps.reduce((sum, s) => sum + s.amount_xlm, 0),
      };
    } catch (error) {
      logger.error('Failed to calculate sweep statistics', { error });
      throw error;
    }
  }
}
