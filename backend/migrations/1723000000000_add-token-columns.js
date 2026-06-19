/**
 * @param { import("pg").Pool } pool
 */
exports.up = async (pool) => {
  // Add original_token and original_amount columns to bets table
  await pool.query(`
    ALTER TABLE bets 
    ADD COLUMN IF NOT EXISTS original_token VARCHAR(56) DEFAULT 'XLM',
    ADD COLUMN IF NOT EXISTS original_amount NUMERIC(40) DEFAULT '0';
  `);

  // Create indexes for new columns
  await pool.query(`
    CREATE INDEX IF NOT EXISTS bets_original_token_idx ON bets(original_token);
  `);
};

/**
 * @param { import("pg").Pool } pool
 */
exports.down = async (pool) => {
  await pool.query(`
    DROP INDEX IF EXISTS bets_original_token_idx;
  `);
  
  await pool.query(`
    ALTER TABLE bets 
    DROP COLUMN IF EXISTS original_token,
    DROP COLUMN IF EXISTS original_amount;
  `);
};