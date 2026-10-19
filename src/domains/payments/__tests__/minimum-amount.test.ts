import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub out BullMQ queues so the service can be imported without a Redis connection.
vi.mock('../../../lib/queue', () => ({
  stellarConfirmationQueue: { add: vi.fn() },
  webhookDispatchQueue: { add: vi.fn() },
}));

// Stub Stellar transaction helpers — not exercised by minimum-amount tests.
vi.mock('../../../lib/stellar/transactions', () => ({
  buildPaymentTransaction: vi.fn(),
  submitSignedTransaction: vi.fn(),
  checkTransactionStatus: vi.fn(),
}));

// Stub getWalletBalance so tests stay hermetic (no Stellar network) and always
// report ample funds — these tests are about the minimum-amount floor, not the
// balance check.
vi.mock('../../../lib/stellar/wallet', () => ({
  getWalletBalance: vi.fn().mockResolvedValue({ lumens: '100000', usdc: '100000' }),
}));

import { PaymentService } from '../payment.service';
import { CreateTipSchema } from '../payment.schemas';
import { ValidationError } from '../../../utils/errors';

/**
 * Regression tests for issue #218 (minimum tip/payment amount validation).
 *
 * The expected minimums are hardcoded literals taken directly from the issue's
 * acceptance criteria (0.01 for XLM/USDC, and a sub-dollar USD floor), rather
 * than imported from `config/payment-limits.ts`. Importing the production
 * constant here would make the test trivially pass even if that constant were
 * wrong or accidentally changed to 0 — the exact failure mode this session has
 * been warned about.
 */
describe('Minimum tip amount validation (#218)', () => {
  describe('CreateTipSchema (request-level validation)', () => {
    it('accepts XLM at exactly the 0.01 minimum', () => {
      const result = CreateTipSchema.safeParse({ creatorId: 'c', amount: 0.01, currency: 'XLM' });
      expect(result.success).toBe(true);
    });

    it('rejects XLM below the 0.01 minimum with a 400-shaped issue naming the minimum', () => {
      const result = CreateTipSchema.safeParse({ creatorId: 'c', amount: 0.001, currency: 'XLM' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join('.') === 'amount');
        expect(issue?.message).toContain('0.01');
        expect(issue?.message).toContain('XLM');
      }
    });

    it('accepts USDC at exactly the 0.01 minimum', () => {
      const result = CreateTipSchema.safeParse({ creatorId: 'c', amount: 0.01, currency: 'USDC' });
      expect(result.success).toBe(true);
    });

    it('rejects USDC below the 0.01 minimum', () => {
      const result = CreateTipSchema.safeParse({ creatorId: 'c', amount: 0.005, currency: 'USDC' });
      expect(result.success).toBe(false);
    });

    it('rejects a sub-dollar USD tip below the configured USD minimum', () => {
      // 0.01 clears the XLM/USDC floor but must still fail for the (higher) USD
      // floor, proving the minimum is genuinely per-currency and not a single
      // global constant.
      const result = CreateTipSchema.safeParse({ creatorId: 'c', amount: 0.01, currency: 'USD' });
      expect(result.success).toBe(false);
    });

    it('accepts a USD tip at or above the USD minimum', () => {
      const result = CreateTipSchema.safeParse({ creatorId: 'c', amount: 0.5, currency: 'USD' });
      expect(result.success).toBe(true);
    });

    it('defaults to USD when currency is omitted and still enforces its minimum', () => {
      const result = CreateTipSchema.safeParse({ creatorId: 'c', amount: 0.01 });
      expect(result.success).toBe(false);
    });

    it('rejects zero and negative amounts regardless of currency (existing behavior preserved)', () => {
      expect(
        CreateTipSchema.safeParse({ creatorId: 'c', amount: 0, currency: 'XLM' }).success
      ).toBe(false);
      expect(
        CreateTipSchema.safeParse({ creatorId: 'c', amount: -1, currency: 'XLM' }).success
      ).toBe(false);
    });
  });

  describe('PaymentService.createTip (service-level defense in depth)', () => {
    const userId = 'user-min';
    const creatorId = 'creator-min';
    let service: PaymentService;
    let mockPrisma: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockPrisma = {
        creator: { findUnique: vi.fn(), update: vi.fn() },
        user: { findUnique: vi.fn() },
        wallet: { findFirst: vi.fn() },
        stellarAsset: { findFirst: vi.fn() },
        walletFlag: { findFirst: vi.fn() },
        accountFreeze: { findFirst: vi.fn() },
        webhook: { findMany: vi.fn() },
        tip: {
          create: vi.fn(),
          findUnique: vi.fn(),
          findMany: vi.fn(),
          count: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
        },
        $transaction: vi.fn((callback: (tx: any) => Promise<unknown>) => callback(mockPrisma)),
      };
      service = new PaymentService(mockPrisma);

      mockPrisma.webhook.findMany.mockResolvedValue([]);
      mockPrisma.user.findUnique.mockResolvedValue({ id: userId });
      mockPrisma.creator.findUnique.mockResolvedValue({
        id: creatorId,
        userId: 'other-user',
        isPublic: true,
        verified: true,
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({
        id: 'wallet-1',
        publicKey: 'GABC123',
        verified: true,
      });
      mockPrisma.walletFlag.findFirst.mockResolvedValue(null);
      mockPrisma.accountFreeze.findFirst.mockResolvedValue(null);
      mockPrisma.stellarAsset.findFirst.mockResolvedValue({
        id: 'asset-usdc',
        code: 'USDC',
        issuer: 'GUSDCISSUER',
        enabled: true,
        priority: 100,
      });
      mockPrisma.tip.findUnique.mockResolvedValue(null);
      mockPrisma.tip.create.mockResolvedValue({
        id: 'tip-1',
        fromUserId: userId,
        creatorId,
        amount: 1,
        message: null,
        status: 'pending',
        transactionHash: null,
        assetCode: 'USDC',
        assetIssuer: 'GUSDCISSUER',
        assetDecimals: 7,
        moderationState: 'visible',
        createdAt: new Date(),
        updatedAt: new Date(),
        idempotencyKey: null,
        media: [],
      });
    });

    it('rejects a tip below the minimum even when called directly (bypassing the route schema)', async () => {
      await expect(
        service.createTip(userId, { creatorId, amount: 0.001, currency: 'XLM' } as any)
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockPrisma.tip.create).not.toHaveBeenCalled();
    });

    it('includes the minimum amount and currency in the rejection details', async () => {
      await expect(
        service.createTip(userId, { creatorId, amount: 0.001, currency: 'XLM' } as any)
      ).rejects.toMatchObject({
        statusCode: 400,
        details: { minimumAmount: 0.01, currency: 'XLM' },
      });
    });

    it('allows a tip exactly at the minimum to proceed', async () => {
      const result = await service.createTip(userId, {
        creatorId,
        amount: 0.01,
        currency: 'XLM',
      } as any);
      expect(result.id).toBe('tip-1');
      expect(mockPrisma.tip.create).toHaveBeenCalledTimes(1);
    });
  });
});
