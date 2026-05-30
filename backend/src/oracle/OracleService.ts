// ============================================================
// BOXMEOUT — Oracle Service
// Responsible for fetching fight results from external sources
// and submitting them to Market contracts on Stellar.
// ============================================================

import { verify as cryptoVerify, createPublicKey } from 'crypto';
import { Address, Keypair, xdr } from '@stellar/stellar-sdk';
import { pool } from '../config/db';
import { invokeContract } from '../services/StellarService';
import { logger } from '../utils/logger';
import { cacheGet, cacheSet } from '../services/cache.service';
import type { OracleReport } from '../models/OracleReport';
import type { Market } from '../models/Market';

export type FightOutcome = 'fighter_a' | 'fighter_b' | 'draw' | 'no_contest';

// Shape of a single fight entry returned by the external boxing API
interface BoxingApiFight {
  fight_id: string;
  status: string;
  result?: string;
}

interface BoxingApiResponse {
  fights: BoxingApiFight[];
}

const OUTCOME_INDEX: Record<FightOutcome, number> = {
  fighter_a: 0,
  fighter_b: 1,
  draw: 2,
  no_contest: 3,
};

// ─── Whitelist cache ──────────────────────────────────────────────────────────

let whitelistCache: Set<string> | null = null;
let whitelistFetchedAt = 0;
const WHITELIST_TTL_MS = 5 * 60 * 1000;

async function getOracleWhitelist(): Promise<Set<string>> {
  if (whitelistCache && Date.now() - whitelistFetchedAt < WHITELIST_TTL_MS) {
    return whitelistCache;
  }
  const addresses: string[] = process.env.ORACLE_WHITELIST
    ? process.env.ORACLE_WHITELIST.split(',').map((s) => s.trim())
    : [];
  whitelistCache = new Set(addresses);
  whitelistFetchedAt = Date.now();
  return whitelistCache;
}

// ─── ScVal helpers ────────────────────────────────────────────────────────────

function addressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

function outcomeToScVal(outcomeIndex: number): xdr.ScVal {
  return xdr.ScVal.scvI32(outcomeIndex);
}

function bytesToScVal(buf: Buffer): xdr.ScVal {
  return xdr.ScVal.scvBytes(buf);
}

/**
 * Constructs the canonical signed message that matches the on-chain contract:
 *   concat(to_xdr(match_id), outcome_byte, reported_at_big_endian)
 *
 * On-chain (Rust):
 *   let mut msg = Bytes::new(&env);
 *   msg.append(&report.match_id.clone().to_xdr(&env));  // XDR string: 4-byte len + utf8
 *   msg.push_back(outcome_byte);                          // 1 byte
 *   for b in report.reported_at.to_be_bytes().iter() {   // 8 bytes big-endian
 *       msg.push_back(*b);
 *   }
 */
function buildSignedMessage(match_id: string, outcomeIndex: number, reportedAtMs: bigint): Buffer {
  const matchIdBytes = Buffer.from(match_id, 'utf8');
  const xdrLen = Buffer.alloc(4);
  xdrLen.writeUInt32BE(matchIdBytes.length, 0);

  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64BE(reportedAtMs);

  return Buffer.concat([
    xdrLen,
    matchIdBytes,
    Buffer.from([outcomeIndex]),
    tsBuf,
  ]);
}

/**
 * Builds an xdr.ScVal representation of an OracleReport struct.
 *
 * Soroban SDK 20 serializes #[contracttype] structs as ScvVec
 * where fields are positional (tuple-style):
 *   [0] match_id:       String       → ScvString
 *   [1] outcome:        Outcome      → ScvI32  (enum discriminant)
 *   [2] reported_at:    u64          → ScvU64
 *   [3] signature:      BytesN<64>   → ScvBytes
 *   [4] oracle_address: Address      → ScvAddress
 *   [5] pub_key:        BytesN<32>   → ScvBytes
 */
function buildOracleReportScVal(
  match_id: string,
  outcomeIndex: number,
  reportedAtMs: bigint,
  signature: string,
  oracleAddress: string,
  rawPubKey: Buffer,
): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvString(match_id),
    outcomeToScVal(outcomeIndex),
    xdr.ScVal.scvU64(xdr.Uint64.fromString(reportedAtMs.toString())),
    bytesToScVal(Buffer.from(signature, 'hex')),
    addressToScVal(oracleAddress),
    bytesToScVal(rawPubKey),
  ]);
}

/**
 * Fetches a confirmed fight result from the external boxing data API.
 *
 * Calls configurable external API (e.g. API-Sports or TheSportsDB) and returns the outcome
 * if the fight status is "confirmed", or null if the result is not yet available.
 *
 * Caches results for 60 seconds to avoid excessive API calls.
 * Handles 404 (fight not found) and 5xx (API down) gracefully.
 * API key read from environment variable.
 *
 * Throws on network / non-2xx errors so the caller can decide how to handle them.
 */
export async function fetchExternalFightResult(match_id: string): Promise<FightOutcome | null> {
  const baseUrl = process.env.BOXING_API_URL;
  if (!baseUrl) throw new Error('BOXING_API_URL env var is required');

  const apiKey = process.env.BOXING_API_KEY;
  if (!apiKey) throw new Error('BOXING_API_KEY env var is required');

  // Check cache first
  const cacheKey = `fight_result:${match_id}`;
  const cached = await cacheGet<FightOutcome | null>(cacheKey);
  if (cached !== undefined) {
    logger.debug({ match_id }, 'fetchExternalFightResult: cache hit');
    return cached;
  }

  try {
    const url = `${baseUrl}/fights?fight_id=${encodeURIComponent(match_id)}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-API-Key': apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    // Handle 404 gracefully
    if (response.status === 404) {
      logger.info({ match_id }, 'fetchExternalFightResult: fight not found (404)');
      await cacheSet(cacheKey, null, 60);
      return null;
    }

    // Handle 5xx gracefully
    if (response.status >= 500) {
      logger.warn({ match_id, status: response.status }, 'fetchExternalFightResult: API down (5xx)');
      throw new Error(`Boxing API down: ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(`Boxing API responded ${response.status} for match_id=${match_id}`);
    }

    const body = (await response.json()) as BoxingApiResponse;
    const fight = body.fights?.find((f) => f.fight_id === match_id);

    if (!fight) {
      logger.info({ match_id }, 'fetchExternalFightResult: fight not found in API response');
      await cacheSet(cacheKey, null, 60);
      return null;
    }

    if (fight.status !== 'confirmed') {
      logger.info({ match_id, apiStatus: fight.status }, 'fetchExternalFightResult: result not yet confirmed');
      return null;
    }

    const validOutcomes: FightOutcome[] = ['fighter_a', 'fighter_b', 'draw', 'no_contest'];
    const outcome = fight.result as FightOutcome | undefined;

    if (!outcome || !validOutcomes.includes(outcome)) {
      throw new Error(
        `Boxing API returned unexpected outcome "${fight.result}" for match_id=${match_id}`,
      );
    }

    // Cache the result for 60 seconds
    await cacheSet(cacheKey, outcome, 60);
    return outcome;
  } catch (err) {
    logger.error({ err, match_id }, 'fetchExternalFightResult: error fetching result');
    throw err;
  }
}

/**
 * Fetches a confirmed fight result from the external boxing data API.
 */
export async function fetchPrimaryResult(match_id: string): Promise<FightOutcome | null> {
  return fetchExternalFightResult(match_id);
}

/**
 * Fetches a fight result from a secondary boxing data source (fallback oracle).
 * Used when the primary source is unavailable or returns conflicting data.
 *
 * Currently configured to query an alternative API endpoint (BOXING_FALLBACK_API_URL)
 * and returns the outcome if the fight status is "confirmed".
 *
 * Returns the outcome string if found, null if the result is not yet available.
 */
export async function fetchFallbackResult(match_id: string): Promise<FightOutcome | null> {
  const baseUrl = process.env.BOXING_FALLBACK_API_URL;
  if (!baseUrl) {
    logger.warn({ match_id }, 'fetchFallbackResult: BOXING_FALLBACK_API_URL not configured, skipping');
    return null;
  }

  const apiKey = process.env.BOXING_FALLBACK_API_KEY;
  if (!apiKey) {
    logger.warn({ match_id }, 'fetchFallbackResult: BOXING_FALLBACK_API_KEY not configured, skipping');
    return null;
  }

  const cacheKey = `fight_result_fallback:${match_id}`;
  const cached = await cacheGet<FightOutcome | null>(cacheKey);
  if (cached !== undefined) {
    logger.debug({ match_id }, 'fetchFallbackResult: cache hit');
    return cached;
  }

  try {
    const url = `${baseUrl}/fights?fight_id=${encodeURIComponent(match_id)}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-API-Key': apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) {
      logger.info({ match_id }, 'fetchFallbackResult: fight not found (404)');
      await cacheSet(cacheKey, null, 60);
      return null;
    }

    if (response.status >= 500) {
      logger.warn({ match_id, status: response.status }, 'fetchFallbackResult: fallback API down (5xx)');
      throw new Error(`Fallback boxing API down: ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(`Fallback boxing API responded ${response.status} for match_id=${match_id}`);
    }

    const body = (await response.json()) as BoxingApiResponse;
    const fight = body.fights?.find((f) => f.fight_id === match_id);

    if (!fight) {
      logger.info({ match_id }, 'fetchFallbackResult: fight not found in fallback API response');
      await cacheSet(cacheKey, null, 60);
      return null;
    }

    if (fight.status !== 'confirmed') {
      logger.info({ match_id, apiStatus: fight.status }, 'fetchFallbackResult: result not yet confirmed');
      return null;
    }

    const validOutcomes: FightOutcome[] = ['fighter_a', 'fighter_b', 'draw', 'no_contest'];
    const outcome = fight.result as FightOutcome | undefined;

    if (!outcome || !validOutcomes.includes(outcome)) {
      throw new Error(
        `Fallback API returned unexpected outcome "${fight.result}" for match_id=${match_id}`,
      );
    }

    await cacheSet(cacheKey, outcome, 60);
    return outcome;
  } catch (err) {
    logger.error({ err, match_id }, 'fetchFallbackResult: error fetching result');
    throw err;
  }
}

/**
 * Cron job that automatically resolves past-deadline markets.
 *
 * Steps:
 *   1. Query all markets with `status IN ('open', 'locked')` and `scheduled_at < NOW()`
 *   2. For each: calls `fetchExternalFightResult()`, then `submitFightResult()` on match
 *   3. Logs markets that could not be auto-resolved (require manual review)
 *   4. Returns `{ resolved: number, skipped: number, failed: number }`
 *   5. Designed to run as a cron job every 10 minutes
 */
export async function runAutoResolutionJob(): Promise<{ resolved: number; skipped: number; failed: number }> {
  const stats = { resolved: 0, skipped: 0, failed: 0 };
  const autoCancelHours = Number(process.env.AUTO_CANCEL_DEADLINE_HOURS ?? 72);

  // Step 1: Query all markets with status IN ('open', 'locked') and scheduled_at < NOW()
  let markets: Pick<Market, 'market_id' | 'match_id'>[];

  try {
    const { rows } = await pool.query<Pick<Market, 'market_id' | 'match_id'>>(
      `SELECT market_id, match_id
         FROM markets
        WHERE status IN ('open', 'locked')
          AND scheduled_at < NOW()
        ORDER BY scheduled_at ASC`,
    );
    markets = rows;
  } catch (err) {
    logger.error({ err }, 'runAutoResolutionJob: failed to query markets');
    return stats;
  }

  if (markets.length === 0) {
    logger.debug('runAutoResolutionJob: no markets pending resolution');
    return stats;
  }

  logger.info({ count: markets.length }, 'runAutoResolutionJob: processing markets');

  // Step 2-4: Process each market independently
  for (const market of markets) {
    const { market_id, match_id } = market;

    try {
      // Step 2: Fetch external fight result (try primary first, then fallback)
      let outcome = await fetchExternalFightResult(match_id);

      // If primary returns nothing, try fallback
      if (outcome === null) {
        outcome = await fetchFallbackResult(match_id);
      }

      // Step 3: If no confirmed result yet, check if we should auto-cancel
      if (outcome === null) {
        const marketResult = await pool.query(
          `SELECT contract_address, scheduled_at
             FROM markets
            WHERE market_id = $1`,
          [market_id],
        );
        if (marketResult.rowCount === 0) {
          logger.warn({ market_id }, 'runAutoResolutionJob: market not found, skipping');
          stats.skipped++;
          continue;
        }

        const { contract_address, scheduled_at } = marketResult.rows[0];
        const deadline = new Date(scheduled_at.getTime() + autoCancelHours * 60 * 60 * 1000);

        if (new Date() > deadline) {
          // Auto-cancel market past deadline
          logger.info(
            { market_id, match_id, scheduled_at, deadline },
            'runAutoResolutionJob: market past deadline, auto-cancelling',
          );

          const keypair = Keypair.fromSecret(process.env.ORACLE_PRIVATE_KEY!);
          const callerAddress = keypair.publicKey();
          const callerScVal = Address.fromString(callerAddress).toScVal();
          const reasonScVal = xdr.ScVal.scvString('auto-cancelled: fight result not confirmed within deadline');

          await invokeContract(contract_address, 'cancel_market', [callerScVal, reasonScVal]);
          stats.resolved++;
          logger.info({ market_id, match_id }, 'runAutoResolutionJob: market auto-cancelled');
        } else {
          logger.info({ market_id, match_id }, 'runAutoResolutionJob: no confirmed result yet, skipping');
          stats.skipped++;
        }
        continue;
      }

      // Step 4: Submit the confirmed result on-chain
      logger.info({ market_id, match_id, outcome }, 'runAutoResolutionJob: submitting fight result');
      await submitFightResult(match_id, outcome);
      stats.resolved++;
      logger.info(
        { market_id, match_id, outcome },
        'runAutoResolutionJob: fight result submitted successfully',
      );
    } catch (err) {
      // Step 5: Log the error but continue processing remaining markets
      logger.error(
        { err, market_id, match_id },
        'runAutoResolutionJob: error processing market, requires manual review',
      );
      stats.failed++;
    }
  }

  logger.info(stats, 'runAutoResolutionJob: completed');
  return stats;
}

/**
 * Legacy alias for runAutoResolutionJob. Exported for backward compatibility.
 */
export const pollFightResults = runAutoResolutionJob;

/**
 * Constructs and submits a resolve_market transaction to Stellar.
 *
 * Steps:
 *   1. Get oracle keypair and raw public key
 *   2. Build the canonical signed message matching on-chain XDR encoding:
 *      to_xdr(match_id) || outcome_byte || reported_at_be
 *   3. Sign with Ed25519 keypair
 *   4. Create `OracleReport` record with `accepted: false` before broadcasting
 *   5. Build ScVal args: [oracle_address, oracle_report_struct]
 *   6. Call StellarService.invokeContract("resolve_market", args)
 *   7. Update `OracleReport.accepted` to `true` with tx_hash on success
 *   8. On failure, log error
 *   9. Return the saved OracleReport
 */
export async function submitFightResult(
  match_id: string,
  outcome: FightOutcome,
): Promise<OracleReport> {
  const secret = process.env.ORACLE_PRIVATE_KEY;
  if (!secret) throw new Error('ORACLE_PRIVATE_KEY env var is required');

  const keypair = Keypair.fromSecret(secret);
  const oracle_address = keypair.publicKey();
  const rawPubKey = keypair.rawPublicKey();
  const reported_at = new Date();

  const outcomeIndex = OUTCOME_INDEX[outcome];
  if (outcomeIndex === undefined) throw new Error(`Invalid fight outcome: ${outcome}`);

  // Build the canonical signed message matching on-chain XDR encoding
  const reportedAtMs = BigInt(reported_at.getTime());
  const message = buildSignedMessage(match_id, outcomeIndex, reportedAtMs);
  const signature = Buffer.from(keypair.sign(message)).toString('hex');

  // Step 1: Create OracleReport with pending status
  const insertResult = await pool.query(
    `INSERT INTO oracle_reports
       (match_id, oracle_address, outcome, reported_at, signature, accepted, tx_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [match_id, oracle_address, outcome, reported_at, signature, false, null],
  );

  const report = insertResult.rows[0] as OracleReport;

  try {
    // Step 3: Retrieve market contract address
    const marketResult = await pool.query(
      'SELECT contract_address FROM markets WHERE match_id = $1 LIMIT 1',
      [match_id],
    );
    if (marketResult.rowCount === 0) {
      throw new Error(`Market not found for match_id: ${match_id}`);
    }

    const contract_address = marketResult.rows[0].contract_address;

    // Step 4: Build ScVal args for resolve_market(oracle: Address, report: OracleReport)
    const oracleScVal = addressToScVal(oracle_address);
    const reportScVal = buildOracleReportScVal(
      match_id,
      outcomeIndex,
      reportedAtMs,
      signature,
      oracle_address,
      rawPubKey,
    );

    // Step 5: Call StellarService.invokeContract
    const tx_hash = await invokeContract(contract_address, 'resolve_market', [oracleScVal, reportScVal]);

    // Step 6: Update report to applied
    const updateResult = await pool.query(
      `UPDATE oracle_reports
       SET accepted = true, tx_hash = $1
       WHERE id = $2
       RETURNING *`,
      [tx_hash, report.id],
    );

    logger.info(
      { match_id, outcome, tx_hash, report_id: report.id },
      'submitFightResult: fight result submitted successfully',
    );

    return updateResult.rows[0] as OracleReport;
  } catch (err) {
    // Step 7: Log error
    logger.error(
      { err, match_id, outcome, report_id: report.id },
      'submitFightResult: error submitting fight result',
    );
    throw err;
  }
}

/**
 * Verifies the authenticity of an OracleReport.
 *
 * Steps:
 *   1. Reconstruct the signed message using XDR encoding (matching on-chain):
 *      to_xdr(match_id) || outcome_byte || reported_at_be
 *   2. Verify signature using Ed25519 against oracle_address public key
 *   3. Check oracle_address is in current oracle whitelist
 *
 * Returns true if valid, false otherwise. Never throws.
 */
export async function verifyOracleReport(report: OracleReport): Promise<boolean> {
  try {
    // 1. Reconstruct signed message using XDR encoding
    const outcomeIndex = OUTCOME_INDEX[report.outcome as FightOutcome];
    if (outcomeIndex === undefined) return false;

    const reportedAtMs = BigInt(new Date(report.reported_at).getTime());
    const message = buildSignedMessage(report.match_id, outcomeIndex, reportedAtMs);

    // 2. Verify Ed25519 signature
    const rawPubKey = Keypair.fromPublicKey(report.oracle_address).rawPublicKey();
    const pubKeyObj = createPublicKey({
      key: Buffer.concat([
        // Ed25519 SubjectPublicKeyInfo DER prefix (12 bytes)
        Buffer.from('302a300506032b6570032100', 'hex'),
        rawPubKey,
      ]),
      format: 'der',
      type: 'spki',
    });

    const sigBuf = Buffer.from(report.signature, 'hex');
    const sigValid = cryptoVerify(null, message, pubKeyObj, sigBuf);
    if (!sigValid) return false;

    // 3. Check whitelist
    const whitelist = await getOracleWhitelist();
    return whitelist.has(report.oracle_address);
  } catch {
    return false;
  }
}

/**
 * Returns the oracle's Stellar G... public address derived from ORACLE_PRIVATE_KEY.
 */
export function getOraclePublicKey(): string {
  const secret = process.env.ORACLE_PRIVATE_KEY;
  if (!secret) throw new Error('ORACLE_PRIVATE_KEY env var is required');
  return Keypair.fromSecret(secret).publicKey();
}

/**
 * Admin manual override for fight result resolution.
 * Used during dispute resolution when automated oracles are wrong.
 *
 * Steps:
 *   1. Build resolve_dispute args: [admin_address, final_outcome]
 *   2. Call StellarService.invokeContract("resolve_dispute", args)
 *   3. Save OracleReport to DB
 *   4. Return tx_hash
 */
export async function adminOverrideResult(
  match_id: string,
  outcome: FightOutcome,
  admin_signature: string,
): Promise<string> {
  const secret = process.env.ADMIN_PRIVATE_KEY;
  if (!secret) throw new Error('ADMIN_PRIVATE_KEY env var is required');

  const keypair = Keypair.fromSecret(secret);
  const adminAddress = keypair.publicKey();
  const reported_at = new Date();

  // Retrieve market contract address
  const marketResult = await pool.query(
    'SELECT contract_address FROM markets WHERE match_id = $1 LIMIT 1',
    [match_id],
  );
  if (marketResult.rowCount === 0) {
    throw new Error(`Market not found for match_id: ${match_id}`);
  }
  const contract_address = marketResult.rows[0].contract_address;

  // Build ScVal args for resolve_dispute(admin: Address, final_outcome: Outcome)
  const outcomeIndex = OUTCOME_INDEX[outcome];
  const adminScVal = addressToScVal(adminAddress);
  const outcomeScVal = outcomeToScVal(outcomeIndex);
  const tx_hash = await invokeContract(contract_address, 'resolve_dispute', [adminScVal, outcomeScVal]);

  // Record outcome in DB
  await pool.query(
    `INSERT INTO oracle_reports
       (match_id, oracle_address, outcome, reported_at, signature, accepted, tx_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [match_id, 'admin', outcome, reported_at, admin_signature, true, tx_hash],
  );

  return tx_hash;
}

/**
 * Raises a dispute on-chain for a market with an admin-verified outcome.
 *
 * Steps:
 *   1. Build dispute_market args: [admin_address, reason]
 *   2. Call StellarService.invokeContract("dispute_market", args)
 *   3. Save OracleReport to DB
 *   4. Return tx_hash
 */
export async function raiseDispute(
  match_id: string,
  outcome: FightOutcome,
  admin_signature: string,
): Promise<string> {
  const secret = process.env.ADMIN_PRIVATE_KEY;
  if (!secret) throw new Error('ADMIN_PRIVATE_KEY env var is required');

  const keypair = Keypair.fromSecret(secret);
  const adminAddress = keypair.publicKey();
  const reported_at = new Date();

  // Retrieve market contract address
  const marketResult = await pool.query(
    'SELECT contract_address FROM markets WHERE match_id = $1 LIMIT 1',
    [match_id],
  );
  if (marketResult.rowCount === 0) {
    throw new Error(`Market not found for match_id: ${match_id}`);
  }
  const contract_address = marketResult.rows[0].contract_address;

  // Build ScVal args for dispute_market(admin: Address, reason: String)
  const adminScVal = addressToScVal(adminAddress);
  const reasonScVal = xdr.ScVal.scvString(`Dispute raised: outcome=${outcome}`);
  const tx_hash = await invokeContract(contract_address, 'dispute_market', [adminScVal, reasonScVal]);

  // Record outcome in DB
  await pool.query(
    `INSERT INTO oracle_reports
       (match_id, oracle_address, outcome, reported_at, signature, accepted, tx_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [match_id, 'admin', outcome, reported_at, admin_signature, true, tx_hash],
  );

  return tx_hash;
}
