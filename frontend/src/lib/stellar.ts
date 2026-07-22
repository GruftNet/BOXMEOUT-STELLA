// ============================================================
// BOXMEOUT — Stellar helpers
// Low-level contract transaction builder and submitter.
// These wrap the Soroban RPC flow so hooks don't need to import
// from @stellar/stellar-sdk directly.
// ============================================================

import {
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
  BASE_FEE,
  xdr,
} from '@stellar/stellar-sdk';

const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet';
const SOROBAN_RPC_URL =
  NETWORK === 'mainnet'
    ? 'https://soroban-rpc.stellar.org'
    : 'https://soroban-testnet.stellar.org';

export const NETWORK_PASSPHRASE =
  NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Build and simulate a contract transaction, returning the prepared XDR string
 * ready to be signed by the user's wallet.
 */
export async function buildContractTransaction(
  senderAddress: string,
  contractAddress: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  const server = new rpc.Server(SOROBAN_RPC_URL);
  const account = await server.getAccount(senderAddress);
  const contract = new Contract(contractAddress);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  return prepared.toXDR();
}

/**
 * Submit a signed transaction XDR string and poll until confirmed.
 * Returns the transaction hash on success.
 */
export async function submitTransaction(signedTxXdr: string): Promise<string> {
  const server = new rpc.Server(SOROBAN_RPC_URL);
  const submitRes = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE),
  );

  if (submitRes.status === 'ERROR') {
    throw new Error(
      `Network rejected transaction: ${submitRes.errorResult?.toString() ?? 'Unknown error'}`,
    );
  }

  let getRes = await server.getTransaction(submitRes.hash);
  for (let i = 0; i < 20 && getRes.status === 'NOT_FOUND'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    getRes = await server.getTransaction(submitRes.hash);
  }

  if (getRes.status !== 'SUCCESS') {
    throw new Error(`Transaction failed with status: ${getRes.status}`);
  }

  return submitRes.hash;
}
