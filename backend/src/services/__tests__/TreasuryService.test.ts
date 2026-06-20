import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TreasuryService } from '../TreasuryService';
import { TreasurySweepRepository } from '../../repositories/TreasurySweepRepository';
import * as Sentry from '@sentry/node';

// Mock dependencies
vi.mock('@sentry/node');
vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('TreasuryService', () => {
  let treasuryService: TreasuryService;
  let mockStellarService: any;
  let mockRepository: any;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock StellarService
    mockStellarService = {
      invokeContract: vi.fn(),
    };

    // Mock TreasurySweepRepository
    mockRepository = {
      recordSweep: vi.fn(),
      findLatestBySweepDate: vi.fn(),
    };

    treasuryService = new TreasuryService(mockStellarService, mockRepository);
  });

  describe('getTreasuryBalance', () => {
    it('should fetch the on-chain Treasury balance successfully', async () => {
      const mockBalance = 50_000_000_000; // 5000 XLM in stroops
      mockStellarService.invokeContract.mockResolvedValueOnce(mockBalance);

      const balance = await treasuryService.getTreasuryBalance();

      expect(balance).toBe(mockBalance);
      expect(mockStellarService.invokeContract).toHaveBeenCalledWith({
        contractId: expect.any(String),
        method: 'get_balance',
        args: [],
      });
    });

    it('should throw error if contract call fails', async () => {
      const error = new Error('Contract call failed');
      mockStellarService.invokeContract.mockRejectedValueOnce(error);

      await expect(treasuryService.getTreasuryBalance()).rejects.toThrow(
        'Contract call failed'
      );
    });
  });

  describe('sweepTreasury - Retry Logic', () => {
    it('should succeed on the first attempt', async () => {
      const txHash = 'tx_hash_success_001';
      mockStellarService.invokeContract.mockResolvedValueOnce(txHash);
      mockRepository.recordSweep.mockResolvedValueOnce(undefined);

      const result = await treasuryService.sweepTreasury(
        'GWALLETADDRESS...',
        50_000_000_000 // 5000 XLM
      );

      expect(result.success).toBe(true);
      expect(result.txHash).toBe(txHash);
      expect(mockStellarService.invokeContract).toHaveBeenCalledTimes(1);
      expect(mockRepository.recordSweep).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          tx_hash: txHash,
        })
      );
    });

    it('should retry 3 times with exponential backoff before failing', async () => {
      const error = new Error('Network timeout');
      mockStellarService.invokeContract.mockRejectedValue(error);
      mockRepository.recordSweep.mockResolvedValueOnce(undefined);

      const startTime = Date.now();
      const result = await treasuryService.sweepTreasury(
        'GWALLETADDRESS...',
        50_000_000_000
      );
      const duration = Date.now() - startTime;

      expect(result.success).toBe(false);
      expect(mockStellarService.invokeContract).toHaveBeenCalledTimes(3);

      // Verify exponential backoff delays (1s, 2s, 4s = 7s total minimum)
      expect(duration).toBeGreaterThanOrEqual(7000);

      // Verify failed sweep was recorded
      expect(mockRepository.recordSweep).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          tx_hash: null,
        })
      );
    });

    it('should succeed on the third attempt after two failures', async () => {
      const txHash = 'tx_hash_success_after_retries';
      const error = new Error('Temporary failure');

      mockStellarService.invokeContract
        .mockRejectedValueOnce(error) // 1st attempt fails
        .mockRejectedValueOnce(error) // 2nd attempt fails
        .mockResolvedValueOnce(txHash); // 3rd attempt succeeds

      mockRepository.recordSweep.mockResolvedValueOnce(undefined);

      const result = await treasuryService.sweepTreasury(
        'GWALLETADDRESS...',
        50_000_000_000
      );

      expect(result.success).toBe(true);
      expect(result.txHash).toBe(txHash);
      expect(mockStellarService.invokeContract).toHaveBeenCalledTimes(3);
      expect(mockRepository.recordSweep).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          tx_hash: txHash,
        })
      );
    });
  });

  describe('sweepTreasury - DB Audit Trail', () => {
    it('should record successful sweep with tx_hash in DB', async () => {
      const txHash = 'tx_hash_audit_001';
      const amountStroops = 50_000_000_000; // 5000 XLM
      mockStellarService.invokeContract.mockResolvedValueOnce(txHash);
      mockRepository.recordSweep.mockResolvedValueOnce(undefined);

      await treasuryService.sweepTreasury('GWALLETADDRESS...', amountStroops);

      expect(mockRepository.recordSweep).toHaveBeenCalledWith({
        amount_xlm: 5000,
        amount_stroops: amountStroops,
        tx_hash: txHash,
        to_address: 'GWALLETADDRESS...',
        status: 'success',
      });
    });

    it('should record failed sweep with null tx_hash in DB', async () => {
      const amountStroops = 50_000_000_000;
      mockStellarService.invokeContract.mockRejectedValue(
        new Error('Contract error')
      );
      mockRepository.recordSweep.mockResolvedValueOnce(undefined);

      await treasuryService.sweepTreasury('GWALLETADDRESS...', amountStroops);

      expect(mockRepository.recordSweep).toHaveBeenCalledWith(
        expect.objectContaining({
          tx_hash: null,
          status: 'failed',
          amount_xlm: 5000,
        })
      );
    });
  });

  describe('sweepTreasury - Sentry Alerting', () => {
    it('should trigger Sentry alert on 3 consecutive failures', async () => {
      mockStellarService.invokeContract.mockRejectedValue(
        new Error('Persistent failure')
      );
      mockRepository.recordSweep.mockResolvedValueOnce(undefined);

      await treasuryService.sweepTreasury('GWALLETADDRESS...', 50_000_000_000);

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('failed after 3 attempts'),
        }),
        expect.objectContaining({
          tags: expect.objectContaining({
            service: 'treasury',
            operation: 'sweep',
          }),
        })
      );
    });

    it('should not trigger Sentry alert on successful sweep', async () => {
      mockStellarService.invokeContract.mockResolvedValueOnce(
        'tx_hash_success'
      );
      mockRepository.recordSweep.mockResolvedValueOnce(undefined);

      await treasuryService.sweepTreasury('GWALLETADDRESS...', 50_000_000_000);

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });
  });

  describe('executeSweepCycle', () => {
    it('should skip sweep if balance is below threshold', async () => {
      const lowBalance = 5_000_000_000; // 500 XLM (below default 1000 XLM threshold)
      mockStellarService.invokeContract.mockResolvedValueOnce(lowBalance);

      await treasuryService.executeSweepCycle();

      // Should only call getTreasuryBalance, not sweepTreasury
      expect(mockStellarService.invokeContract).toHaveBeenCalledTimes(1);
      expect(mockRepository.recordSweep).not.toHaveBeenCalled();
    });

    it('should execute sweep if balance exceeds threshold', async () => {
      const highBalance = 100_000_000_000; // 10,000 XLM
      mockStellarService.invokeContract.mockResolvedValueOnce(highBalance);
      mockStellarService.invokeContract.mockResolvedValueOnce(
        'tx_hash_threshold'
      );
      mockRepository.recordSweep.mockResolvedValueOnce(undefined);
      mockRepository.findLatestBySweepDate.mockResolvedValueOnce(null);

      await treasuryService.executeSweepCycle();

      expect(mockRepository.recordSweep).toHaveBeenCalled();
    });

    it('should prevent duplicate sweeps with same tx_hash', async () => {
      const highBalance = 100_000_000_000;
      const existingTxHash = 'tx_hash_existing';

      mockStellarService.invokeContract.mockResolvedValueOnce(highBalance);
      mockRepository.findLatestBySweepDate.mockResolvedValueOnce({
        tx_hash: existingTxHash,
        status: 'success',
      });

      await treasuryService.executeSweepCycle();

      // Should not call sweepTreasury again
      expect(mockRepository.recordSweep).not.toHaveBeenCalled();
    });
  });

  describe('Stroops conversion', () => {
    it('should correctly convert stroops to XLM', async () => {
      const txHash = 'tx_hash_conversion';
      mockStellarService.invokeContract.mockResolvedValueOnce(txHash);
      mockRepository.recordSweep.mockResolvedValueOnce(undefined);

      const result = await treasuryService.sweepTreasury(
        'GWALLETADDRESS...',
        12_345_678_901 // stroops
      );

      expect(result.amountXlm).toBeCloseTo(1234.5678901, 6);
      expect(mockRepository.recordSweep).toHaveBeenCalledWith(
        expect.objectContaining({
          amount_xlm: expect.closeTo(1234.5678901, 6),
        })
      );
    });
  });
});
