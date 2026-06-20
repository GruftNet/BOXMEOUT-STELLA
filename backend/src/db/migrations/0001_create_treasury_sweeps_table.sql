-- Migration: Add treasury_sweeps table for audit trail
-- Created: 2026-06-20
-- Description: Create table to record all Treasury sweep events with full audit trail

CREATE TABLE IF NOT EXISTS treasury_sweeps (
  id SERIAL PRIMARY KEY,
  swept_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  amount_xlm NUMERIC(20, 7) NOT NULL,
  amount_stroops NUMERIC(20, 0) NOT NULL,
  tx_hash VARCHAR(255) UNIQUE,
  to_address VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for common queries
CREATE INDEX idx_treasury_sweeps_swept_at ON treasury_sweeps(swept_at DESC);
CREATE INDEX idx_treasury_sweeps_status ON treasury_sweeps(status);
CREATE INDEX idx_treasury_sweeps_tx_hash ON treasury_sweeps(tx_hash);
CREATE INDEX idx_treasury_sweeps_to_address ON treasury_sweeps(to_address);

-- Add comments for documentation
COMMENT ON TABLE treasury_sweeps IS 'Audit trail for Treasury fee sweep operations';
COMMENT ON COLUMN treasury_sweeps.id IS 'Unique identifier for the sweep event';
COMMENT ON COLUMN treasury_sweeps.swept_at IS 'Timestamp when the sweep was executed';
COMMENT ON COLUMN treasury_sweeps.amount_xlm IS 'Amount swept in XLM';
COMMENT ON COLUMN treasury_sweeps.amount_stroops IS 'Amount swept in stroops (on-chain unit)';
COMMENT ON COLUMN treasury_sweeps.tx_hash IS 'Blockchain transaction hash (null if failed)';
COMMENT ON COLUMN treasury_sweeps.to_address IS 'Destination wallet address';
COMMENT ON COLUMN treasury_sweeps.status IS 'Status of the sweep: success or failed';
