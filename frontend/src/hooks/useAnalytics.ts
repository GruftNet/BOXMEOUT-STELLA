// ============================================================
// BOXMEOUT — useAnalytics Hook
// Provides a stable analytics context bound to the current wallet.
// Handles identity hashing so callers never touch raw addresses.
// ============================================================

import { useEffect, useRef, useCallback } from 'react';
import { hashAddress, identifyUser, resetIdentity } from '../lib/analytics';
import { useAppStore } from '../store';

export interface UseAnalyticsResult {
  /**
   * Returns the hashed distinct-id for the current wallet, or null if not connected.
   * Useful when callers need to include the id in a manual track() call.
   */
  getHashedId: () => Promise<string | null>;
  /**
   * Detect wallet provider from the browser environment (Freighter / Albedo / unknown).
   */
  detectWalletProvider: () => 'freighter' | 'albedo' | 'unknown';
}

export function useAnalytics(): UseAnalyticsResult {
  const walletAddress = useAppStore((s) => s.walletAddress);
  const prevAddressRef = useRef<string | null>(null);

  // Re-identify (or reset) whenever the wallet address changes.
  useEffect(() => {
    const prev = prevAddressRef.current;
    prevAddressRef.current = walletAddress;

    if (walletAddress && walletAddress !== prev) {
      // New connection — hash then identify
      hashAddress(walletAddress).then(identifyUser).catch(() => {});
    } else if (!walletAddress && prev) {
      // Disconnection — reset Mixpanel identity
      resetIdentity();
    }
  }, [walletAddress]);

  const getHashedId = useCallback(async (): Promise<string | null> => {
    if (!walletAddress) return null;
    return hashAddress(walletAddress);
  }, [walletAddress]);

  const detectWalletProvider = useCallback((): 'freighter' | 'albedo' | 'unknown' => {
    if (typeof window === 'undefined') return 'unknown';
    if ((window as any).freighter) return 'freighter';
    if ((window as any).albedo) return 'albedo';
    return 'unknown';
  }, []);

  return { getHashedId, detectWalletProvider };
}
