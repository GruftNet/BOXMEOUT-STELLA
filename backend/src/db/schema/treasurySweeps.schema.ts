import { pgTable, serial, timestamp, numeric, varchar, text } from 'drizzle-orm/pg-core';

/**
 * Treasury sweeps table schema
 * Records all Treasury sweep events with full audit trail
 */
export const treasurySweeps = pgTable('treasury_sweeps', {
  // Primary key
  id: serial('id').primaryKey(),

  // Timestamp of when the sweep was executed
  swept_at: timestamp('swept_at', { withTimezone: true }).notNull().defaultNow(),

  // Amount swept in XLM (decimal for precision)
  amount_xlm: numeric('amount_xlm', { precision: 20, scale: 7 }).notNull(),

  // Amount swept in stroops (for on-chain reference)
  amount_stroops: numeric('amount_stroops', { precision: 20, scale: 0 }).notNull(),

  // Transaction hash from the blockchain
  tx_hash: varchar('tx_hash', { length: 255 }).unique(),

  // Destination wallet address
  to_address: varchar('to_address', { length: 255 }).notNull(),

  // Status: 'success' if sweep completed, 'failed' if all retries exhausted
  status: varchar('status', { length: 20 }).notNull().default('pending'),
});

// TypeScript type inference
export type TreasurySweep = typeof treasurySweeps.$inferSelect;
export type NewTreasurySweep = typeof treasurySweeps.$inferInsert;
