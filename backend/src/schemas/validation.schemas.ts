import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

// --- Sanitization helper ---

export function stripHtml(val: string): string {
  val = val.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  val = val.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  val = val.replace(/\s+on\w+="[^"]*"/gi, '');
  val = val.replace(/\s+on\w+='[^']*'/gi, '');
  val = val.replace(/javascript:[^"']*/gi, '');
  val = val.replace(/<[^>]*>/g, '');
  val = val.replace(/&(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, '');
  return val;
}

export function sanitizedString(min: number, max: number) {
  return z.string().trim().transform(stripHtml).pipe(z.string().min(min).max(max));
}

// --- Shared primitives ---

export const stellarAddress = z
  .string()
  .refine((val) => StrKey.isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public key format or checksum',
  });

export const uuidParam = z.object({ id: z.string().uuid() });
export const marketIdParam = z.object({ marketId: z.string().uuid() });

// --- Auth schemas ---

export const emailSchema = z
  .string()
  .email('Invalid email format')
  .min(5)
  .max(254);

export const passwordSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const registerBody = z.object({
  email: emailSchema,
  username: sanitizedString(3, 50),
  password: passwordSchema,
});

export const emailLoginBody = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

export const challengeBody = z.object({ publicKey: stellarAddress });

export const loginBody = z.object({
  publicKey: stellarAddress,
  signature: z.string().min(1, 'Signature is required'),
  nonce: z.string().min(1, 'Nonce is required'),
});

export const refreshBody = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const logoutBody = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// --- Market schemas ---

const MARKET_STATUSES = ['open', 'locked', 'resolved', 'cancelled', 'disputed'] as const;
const MARKET_CATEGORIES = ['BOXING', 'MMA', 'KICKBOXING', 'OTHER'] as const;

export const listMarketsQuery = z.object({
  status: z.enum(MARKET_STATUSES).optional(),
  weight_class: z.string().min(1).optional(),
  fighter: z.string().min(1).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createMarketBody = z
  .object({
    title: sanitizedString(5, 200),
    description: sanitizedString(10, 5000),
    category: z.enum(MARKET_CATEGORIES),
    outcomeA: sanitizedString(1, 100),
    outcomeB: sanitizedString(1, 100),
    closingAt: z
      .string()
      .datetime()
      .refine((val) => new Date(val) > new Date(), {
        message: 'Closing time must be in the future',
      }),
    resolutionTime: z.string().datetime().optional(),
  })
  .refine(
    (data) => !data.resolutionTime || new Date(data.resolutionTime) > new Date(data.closingAt),
    { message: 'Resolution time must be after closing time', path: ['resolutionTime'] },
  );

export const resolveMarketBody = z.object({
  winning_outcome: z.enum(['fighter_a', 'fighter_b', 'draw', 'no_contest'], {
    errorMap: () => ({ message: 'winning_outcome must be one of: fighter_a, fighter_b, draw, no_contest' }),
  }),
});

// --- Oracle submission schema ---

export const oracleSubmitBody = z.object({
  match_id: z.string().min(1, 'match_id is required'),
  outcome: z.enum(['fighter_a', 'fighter_b', 'draw', 'no_contest'], {
    errorMap: () => ({ message: 'outcome must be one of: fighter_a, fighter_b, draw, no_contest' }),
  }),
  reported_at: z.string().datetime({ message: 'reported_at must be a valid ISO 8601 datetime string' }),
  signature: z.string().regex(/^[0-9a-fA-F]+$/, 'signature must be a hex-encoded string').min(1),
  oracle_address: z.string().min(1, 'oracle_address is required'),
});

// --- Dispute schemas ---

export const submitDisputeBody = z.object({
  marketId: z.string().min(1, 'marketId is required'),
  reason: sanitizedString(10, 1000),
  evidenceUrl: z.string().url().optional().or(z.literal('')),
});

export const reviewDisputeBody = z.object({
  adminNotes: sanitizedString(5, 5000),
});

export const resolveDisputeBody = z
  .object({
    action: z.enum(['DISMISS', 'RESOLVE_NEW_OUTCOME']),
    resolution: sanitizedString(10, 5000),
    adminNotes: sanitizedString(5, 5000).optional(),
    newWinningOutcome: z.number().int().min(0).max(1).optional(),
    notifyEmail: z.string().email().optional(),
  })
  .refine(
    (data) => !(data.action === 'RESOLVE_NEW_OUTCOME' && data.newWinningOutcome === undefined),
    { message: 'New winning outcome is required when action is RESOLVE_NEW_OUTCOME', path: ['newWinningOutcome'] },
  );

// --- Bet / trading schemas ---

export const buySharesBody = z.object({
  outcome: z.number().int().min(0).max(1),
  amount: z
    .string()
    .regex(/^\d+$/, 'Amount must be a numeric string (USDC base units)')
    .refine((val) => { try { return BigInt(val) > 0n; } catch { return false; } }, { message: 'Amount must be greater than 0' })
    .refine((val) => { try { return BigInt(val) <= 1_000_000_000_000n; } catch { return false; } }, { message: 'Amount exceeds maximum limit' }),
  minShares: z.string().regex(/^\d+$/, 'minShares must be a numeric string').optional(),
});

export const sellSharesBody = z.object({
  outcome: z.number().int().min(0).max(1),
  shares: z
    .string()
    .regex(/^\d+$/, 'Shares must be a numeric string (base units)')
    .refine((val) => { try { return BigInt(val) > 0n; } catch { return false; } }, { message: 'Shares must be greater than 0' }),
  minPayout: z.string().regex(/^\d+$/, 'minPayout must be a numeric string').optional(),
});

export const submitTxBody = z.object({
  signedXdr: z
    .string()
    .min(1, 'signedXdr is required')
    .regex(/^[A-Za-z0-9+/]+=*$/, 'signedXdr must be a valid base64 string'),
});

// --- User profile ---

export const updateProfileBody = z
  .object({
    username: z
      .string()
      .trim()
      .transform(stripHtml)
      .pipe(
        z.string()
          .min(3)
          .max(30)
          .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers, and underscores'),
      )
      .optional(),
    avatarUrl: z.string().url('avatarUrl must be a valid URL').optional(),
  })
  .refine((data) => data.username !== undefined || data.avatarUrl !== undefined, {
    message: 'At least one field (username or avatarUrl) must be provided',
  });
