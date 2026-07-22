import { useState, useEffect, useCallback } from 'react';
import { connectWallet, disconnectWallet, getConnectedAddress, getWalletBalance } from '../services/wallet';
import { useAppStore } from '../store';
import {
  trackWalletConnected,
  trackWalletDisconnected,
  trackWalletConnectionFailed,
} from '../services/analytics.service';
import { hashAddress } from '../lib/analytics';

export interface UseWalletResult {
  address: string | null;
  balance: number | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const STORAGE_KEY = 'boxmeout_wallet_address';

export function useWallet(): UseWalletResult {
  const { walletAddress, walletBalance, isConnecting, setWallet, clearWallet } = useAppStore();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = getConnectedAddress();
    if (stored) {
      getWalletBalance().then((bal) => setWallet(stored, bal)).catch(() => {});
    }
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    useAppStore.setState({ isConnecting: true });
    try {
      const address = await connectWallet();
      const balance = await getWalletBalance();
      sessionStorage.setItem(STORAGE_KEY, address);
      setWallet(address, balance);

      // Analytics: identify user and track wallet connect
      const provider =
        typeof window !== 'undefined' && (window as any).freighter
          ? 'freighter'
          : typeof window !== 'undefined' && (window as any).albedo
            ? 'albedo'
            : 'unknown';
      const hashed = await hashAddress(address);
      trackWalletConnected({ hashed_address: hashed, wallet_provider: provider });
    } catch (e: any) {
      const msg = e?.message ?? 'Failed to connect wallet';
      setError(msg);
      const provider =
        typeof window !== 'undefined' && (window as any).freighter
          ? 'freighter'
          : typeof window !== 'undefined' && (window as any).albedo
            ? 'albedo'
            : 'unknown';
      trackWalletConnectionFailed({ error: msg, wallet_provider: provider });
    } finally {
      useAppStore.setState({ isConnecting: false });
    }
  }, [setWallet]);

  const disconnect = useCallback(() => {
    const address = useAppStore.getState().walletAddress;
    disconnectWallet();
    sessionStorage.removeItem(STORAGE_KEY);
    clearWallet();
    if (address) {
      hashAddress(address)
        .then((hashed) => trackWalletDisconnected({ hashed_address: hashed }))
        .catch(() => {});
    }
  }, [clearWallet]);

  return {
    address: walletAddress,
    balance: walletBalance,
    isConnected: !!walletAddress,
    isConnecting,
    error,
    connect,
    disconnect,
  };
}
