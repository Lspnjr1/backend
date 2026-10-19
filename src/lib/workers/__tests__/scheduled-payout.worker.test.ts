import { describe, it, expect, beforeEach, vi } from 'vitest';
import { triggerScheduledPayout } from '../scheduled-payout.worker';

/**
 * Regression tests for the scheduled-payout trigger logic extracted from
 * `scheduled-payout.worker.ts` (issue #222).
 *
 * As with `verifyTipBalance` (#221), this tests the triggerable logic
 * directly against fake `PayoutService`/`ScheduledPayoutService`/prisma
 * doubles rather than constructing a real BullMQ `Worker`, which opens a
 * Redis connection on construction. Whether BullMQ's job scheduler actually
 * fires this job on the configured cron cadence against a live Redis
 * instance is NOT exercised here; see the PR body's Disclosures section.
 */
describe('triggerScheduledPayout (#222)', () => {
  let mockPrisma: { scheduledPayment: { findUnique: ReturnType<typeof vi.fn> } };
  let mockPayoutService: { processPayout: ReturnType<typeof vi.fn> };
  let mockScheduledPayoutService: { recordRunOutcome: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = { scheduledPayment: { findUnique: vi.fn() } };
    mockPayoutService = { processPayout: vi.fn() };
    mockScheduledPayoutService = { recordRunOutcome: vi.fn().mockResolvedValue(undefined) };
  });

  const baseData = { scheduledPaymentId: 'sched-1', creatorId: 'creator-1' };

  function activeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sched-1',
      creatorId: 'creator-1',
      amount: 100,
      walletAddress: null,
      cronExpression: '0 0 * * *',
      status: 'active',
      ...overrides,
    };
  }

  it('triggers a payout via PayoutService.processPayout when the schedule is active', async () => {
    mockPrisma.scheduledPayment.findUnique.mockResolvedValue(activeRow());
    mockPayoutService.processPayout.mockResolvedValue({ id: 'payout-1', amount: 100 });

    const result = await triggerScheduledPayout(
      mockPrisma as any,
      mockPayoutService as any,
      mockScheduledPayoutService as any,
      baseData
    );

    expect(result.triggered).toBe(true);
    expect(result.payoutId).toBe('payout-1');
    expect(mockPayoutService.processPayout).toHaveBeenCalledWith('creator-1', {
      amount: 100,
      walletAddress: undefined,
    });
  });

  it('records the run outcome with the resulting payout id on success', async () => {
    mockPrisma.scheduledPayment.findUnique.mockResolvedValue(activeRow());
    mockPayoutService.processPayout.mockResolvedValue({ id: 'payout-2', amount: 100 });

    await triggerScheduledPayout(
      mockPrisma as any,
      mockPayoutService as any,
      mockScheduledPayoutService as any,
      baseData
    );

    expect(mockScheduledPayoutService.recordRunOutcome).toHaveBeenCalledWith('sched-1', {
      payoutId: 'payout-2',
    });
  });

  it.each(['paused', 'cancelled'])(
    'does NOT trigger a payout when the schedule status is %s (race between pause/cancel and an already-fired job)',
    async (status) => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(activeRow({ status }));

      const result = await triggerScheduledPayout(
        mockPrisma as any,
        mockPayoutService as any,
        mockScheduledPayoutService as any,
        baseData
      );

      expect(result.triggered).toBe(false);
      expect(mockPayoutService.processPayout).not.toHaveBeenCalled();
      expect(mockScheduledPayoutService.recordRunOutcome).not.toHaveBeenCalled();
    }
  );

  it('does NOT trigger a payout when the schedule no longer exists', async () => {
    mockPrisma.scheduledPayment.findUnique.mockResolvedValue(null);

    const result = await triggerScheduledPayout(
      mockPrisma as any,
      mockPayoutService as any,
      mockScheduledPayoutService as any,
      baseData
    );

    expect(result.triggered).toBe(false);
    expect(result.skippedReason).toBe('schedule not found');
    expect(mockPayoutService.processPayout).not.toHaveBeenCalled();
  });

  it('records the run outcome with the error and re-throws when processPayout fails (so BullMQ retries it)', async () => {
    mockPrisma.scheduledPayment.findUnique.mockResolvedValue(activeRow());
    mockPayoutService.processPayout.mockRejectedValue(new Error('Insufficient pending balance'));

    await expect(
      triggerScheduledPayout(
        mockPrisma as any,
        mockPayoutService as any,
        mockScheduledPayoutService as any,
        baseData
      )
    ).rejects.toThrow('Insufficient pending balance');

    expect(mockScheduledPayoutService.recordRunOutcome).toHaveBeenCalledWith('sched-1', {
      error: 'Insufficient pending balance',
    });
  });

  it('uses the schedule walletAddress override when set', async () => {
    mockPrisma.scheduledPayment.findUnique.mockResolvedValue(
      activeRow({ walletAddress: 'GCUSTOMWALLET' })
    );
    mockPayoutService.processPayout.mockResolvedValue({ id: 'payout-3', amount: 100 });

    await triggerScheduledPayout(
      mockPrisma as any,
      mockPayoutService as any,
      mockScheduledPayoutService as any,
      baseData
    );

    expect(mockPayoutService.processPayout).toHaveBeenCalledWith('creator-1', {
      amount: 100,
      walletAddress: 'GCUSTOMWALLET',
    });
  });
});
