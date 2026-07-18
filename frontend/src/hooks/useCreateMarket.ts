import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import type { TxStatus } from '../types';
import type { CreateMarketParams } from '../services/wallet';
import { createMarket as createMarketWallet, getConnectedAddress } from '../services/wallet';

export interface UseCreateMarketResult {
  createMarket: (params: CreateMarketParams) => Promise<void>;
  txStatus: TxStatus['status'];
  txHash: string | null;
  error: string | null;
}

function parseMarketId(returnValueXdr: string): string {
  if (!returnValueXdr) throw new Error('No return value in transaction result');
  // Simple extraction of address from ScVal XDR
  // In production, use the SDK's scValToNative helper
  try {
    const val = xdr.ScVal.fromXDR(returnValueXdr, 'base64');
    const native = scValToNative(val);
    if (typeof native === 'string') return native;
  } catch (err) {
    console.error('Error parsing market ID:', err);
  }
  throw new Error('Could not parse market ID from transaction result');
}

export function useCreateMarket(): UseCreateMarketResult {
  const router = useRouter();
  const [txStatus, setTxStatus] = useState<TxStatus['status']>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createMarket = useCallback(async (params: CreateMarketParams) => {
    const address = getConnectedAddress();
    if (!address) throw new Error('Wallet not connected');

    setTxStatus('signing');
    setTxHash(null);
    setError(null);

    try {
      // 1. Build, sign and submit via the centralized wallet service helper
      const hash = await createMarketWallet(params);
      setTxHash(hash);

      // 4. Parse market ID from result
      const { rpc } = await import('@stellar/stellar-sdk');
      const server = new rpc.Server(
        process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet'
          ? 'https://soroban-rpc.stellar.org'
          : 'https://soroban-testnet.stellar.org',
      );
      const txResult = await server.getTransaction(hash);
      if (txResult.status !== 'SUCCESS') throw new Error('Transaction did not succeed');

      const resultXdr = (txResult as any).returnValue
        ? (txResult as any).returnValue.toXDR('base64')
        : '';
      const marketId = parseMarketId(resultXdr);

      setTxStatus('success');
      router.push(`/markets/${marketId}`);
    } catch (e: any) {
      setTxStatus('error');
      setError(e?.message ?? String(e));
    }
  }, [router]);

  return { createMarket, txStatus, txHash, error };
}
