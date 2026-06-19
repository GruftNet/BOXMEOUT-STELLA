// ============================================================
// BOXMEOUT — useTokenRates Hook
// Fetches live token to XLM rates from Horizon for path payment preview
// ============================================================

import { useQuery } from '@tanstack/react-query';

export interface ApprovedToken {
  token: string;
  symbol: string;
  max_slippage_bps: number;
}

export interface TokenRate {
  token: string;
  symbol: string;
  xlm_equivalent: number;
  rate: number; // token per XLM
  source_amount: number;
  dest_amount: number;
}

// Approved tokens list - in production, this would come from the factory contract
const APPROVED_TOKENS: ApprovedToken[] = [
  { token: 'XLM', symbol: 'XLM', max_slippage_bps: 0 },
  // Testnet USDC - replace with actual testnet asset
  { token: 'CDMLF2WSM5DGLCD2GZU6SJR2W3NYACQ3LMP5P7VHL7XR7C7B2BKV2JCD', symbol: 'USDC', max_slippage_bps: 50 },
  { token: 'ABOZRE5KYRH6KKUM3RKNTEXT5K74TH6MZXJUDC4J7RII7Y4XLGP3VJDF', symbol: 'AQUA', max_slippage_bps: 200 },
];

const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org';

/**
 * Fetches the XLM equivalent for a given token amount using Horizon's /paths endpoint
 */
async function fetchTokenRate(tokenAddress: string, amount: number): Promise<TokenRate | null> {
  // Native XLM - no conversion needed
  if (tokenAddress === 'XLM' || tokenAddress.length < 10) {
    return {
      token: tokenAddress,
      symbol: 'XLM',
      xlm_equivalent: amount,
      rate: 1,
      source_amount: amount,
      dest_amount: amount,
    };
  }

  try {
    // Use Horizon's /paths/strict-send endpoint
    // source_asset_type=credit4 means it's a token with 4 decimal places (like USDC)
    const url = new URL(`${HORIZON_URL}/paths/strict-send`);
    url.searchParams.set('source_asset_type', 'native');
    url.searchParams.set('source_amount', amount.toString());
    url.searchParams.set('destination_asset_type', 'credit4');
    url.searchParams.set('destination_asset_code', 'USDC');
    url.searchParams.set('destination_asset_issuer', tokenAddress);

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error('Failed to fetch token rate:', response.status);
      return null;
    }

    const data = await response.json();
    if (!data.records || data.records.length === 0) {
      return null;
    }

    // Get the best path (first record)
    const path = data.records[0];
    return {
      token: tokenAddress,
      symbol: path.destination_asset_code || 'UNKNOWN',
      xlm_equivalent: parseFloat(path.source_amount),
      rate: parseFloat(path.source_amount) / parseFloat(path.destination_amount),
      source_amount: parseFloat(path.source_amount),
      dest_amount: parseFloat(path.destination_amount),
    };
  } catch (error) {
    console.error('Error fetching token rate:', error);
    return null;
  }
}

/**
 * Hook to get approved tokens with live XLM rates
 */
export function useTokenRates(amount: number = 10000000) { // Default 10 XLM in stroops
  return useQuery({
    queryKey: ['tokenRates', amount],
    queryFn: async () => {
      const rates: TokenRate[] = [];
      for (const token of APPROVED_TOKENS) {
        const rate = await fetchTokenRate(token.token, amount);
        if (rate) {
          rates.push(rate);
        }
      }
      return rates;
    },
    staleTime: 30_000, // 30 seconds
    refetchInterval: 60_000, // Refetch every minute
  });
}

/**
 * Get the approved tokens list
 */
export function getApprovedTokens(): ApprovedToken {
  return APPROVED_TOKENS;
}

export { APPROVED_TOKENS };