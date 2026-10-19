import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../stellar/wallet', () => ({
  getWalletBalance: vi.fn(),
}));

import { verifyTipBalance } from '../balance-verification.worker';
import { getWalletBalance } from '../../stellar/wallet';

const mockGetWalletBalance = getWalletBalance as ReturnType<typeof vi.fn>;

/**
 * Regression tests for the balance-verification logic extracted from
 * `balance-verification.worker.ts` (issue #221).
 *
 * `verifyTipBalance` is tested directly (not through a constructed `Worker`,
 * which opens a Redis connection on construction and is not something this
 * session can exercise without a live Redis instance) against a fake
 * `PaymentService`, so these tests exercise the actual insufficient-balance
 * rule and the FAILED transition without any BullMQ or database involvement.
 */
describe('verifyTipBalance (#221)', () => {
  let mockPaymentService: {
    getTip: ReturnType<typeof vi.fn>;
    updateTipStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentService = {
      getTip: vi.fn().mockResolvedValue({ id: 'tip-1', status: 'pending' }),
      updateTipStatus: vi.fn().mockResolvedValue({ id: 'tip-1', status: 'failed' }),
    };
  });

  const baseData = {
    tipId: 'tip-1',
    walletPublicKey: 'GABC123',
    assetCode: 'USDC',
    requiredAmount: 100,
  };

  it('marks the tip FAILED when the on-chain balance is below the required amount', async () => {
    mockGetWalletBalance.mockResolvedValue({ lumens: '500', usdc: '5' });

    const result = await verifyTipBalance(mockPaymentService as any, baseData);

    expect(result.sufficient).toBe(false);
    expect(mockPaymentService.updateTipStatus).toHaveBeenCalledWith('tip-1', { status: 'failed' });
  });

  it('treats a missing (undefined) asset balance as zero and marks the tip FAILED', async () => {
    mockGetWalletBalance.mockResolvedValue({ lumens: '100' }); // no usdc field

    const result = await verifyTipBalance(mockPaymentService as any, baseData);

    expect(result.sufficient).toBe(false);
    expect(result.currentBalance).toBe(0);
    expect(mockPaymentService.updateTipStatus).toHaveBeenCalledWith('tip-1', { status: 'failed' });
  });

  it('does NOT mark the tip FAILED when the balance covers the required amount', async () => {
    mockGetWalletBalance.mockResolvedValue({ lumens: '100', usdc: '1000' });

    const result = await verifyTipBalance(mockPaymentService as any, baseData);

    expect(result.sufficient).toBe(true);
    expect(mockPaymentService.updateTipStatus).not.toHaveBeenCalled();
  });

  it('treats an exactly-equal balance as sufficient (boundary case)', async () => {
    mockGetWalletBalance.mockResolvedValue({ lumens: '100', usdc: '100' });

    const result = await verifyTipBalance(mockPaymentService as any, baseData);

    expect(result.sufficient).toBe(true);
    expect(mockPaymentService.updateTipStatus).not.toHaveBeenCalled();
  });

  it('propagates a getWalletBalance failure (so BullMQ retries it) instead of silently marking the tip FAILED on the first error', async () => {
    mockGetWalletBalance.mockRejectedValue(new Error('Stellar network unreachable'));

    await expect(verifyTipBalance(mockPaymentService as any, baseData)).rejects.toThrow(
      'Stellar network unreachable'
    );
    expect(mockPaymentService.updateTipStatus).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'skips verification entirely when the tip is already in a terminal state (%s)',
    async (status) => {
      mockPaymentService.getTip.mockResolvedValue({ id: 'tip-1', status });

      const result = await verifyTipBalance(mockPaymentService as any, baseData);

      expect(result.skipped).toBe(true);
      expect(mockGetWalletBalance).not.toHaveBeenCalled();
      expect(mockPaymentService.updateTipStatus).not.toHaveBeenCalled();
    }
  );

  it('still runs verification when the tip is pending (not yet terminal)', async () => {
    mockPaymentService.getTip.mockResolvedValue({ id: 'tip-1', status: 'pending' });
    mockGetWalletBalance.mockResolvedValue({ lumens: '100', usdc: '1000' });

    const result = await verifyTipBalance(mockPaymentService as any, baseData);

    expect(result.skipped).toBeUndefined();
    expect(mockGetWalletBalance).toHaveBeenCalledWith('GABC123');
  });
});
