import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockUpsertJobScheduler, mockRemoveJobScheduler } = vi.hoisted(() => ({
  mockUpsertJobScheduler: vi.fn(),
  mockRemoveJobScheduler: vi.fn(),
}));

vi.mock('../../../lib/queue', () => ({
  scheduledPayoutQueue: {
    upsertJobScheduler: mockUpsertJobScheduler,
    removeJobScheduler: mockRemoveJobScheduler,
  },
}));

vi.mock('../../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/env')>();
  return {
    ...actual,
    config: { ...actual.config, MIN_PAYOUT_AMOUNT: 50 },
  };
});

import { ScheduledPayoutService } from '../scheduled-payout.service';
import { NotFoundError, ValidationError } from '../../../utils/errors';

/**
 * Regression tests for issue #222 (scheduled creator payouts), scoped to what
 * is verifiable without a live Redis instance: the ScheduledPayment CRUD and
 * the BullMQ job-scheduler registration calls (upsert/remove) the service is
 * responsible for making, asserted by mocking the queue rather than
 * connecting to Redis. See the PR body for what is NOT covered (an actual
 * cron firing end-to-end).
 */
describe('ScheduledPayoutService (#222)', () => {
  const creatorId = 'creator-1';
  let mockPrisma: any;
  let service: ScheduledPayoutService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = {
      scheduledPayment: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };
    service = new ScheduledPayoutService(mockPrisma);
    mockUpsertJobScheduler.mockResolvedValue({});
    mockRemoveJobScheduler.mockResolvedValue(true);
  });

  function makeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sched-1',
      creatorId,
      amount: 100,
      walletAddress: null,
      cronExpression: '0 0 * * *',
      status: 'active',
      lastRunAt: null,
      lastPayoutId: null,
      lastRunError: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  describe('createScheduledPayout', () => {
    it('rejects an amount below the configured minimum payout (literal 50)', async () => {
      await expect(
        service.createScheduledPayout(creatorId, { amount: 10, recurrence: 'daily' } as any)
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockPrisma.scheduledPayment.create).not.toHaveBeenCalled();
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });

    it('accepts an amount exactly at the minimum payout', async () => {
      mockPrisma.scheduledPayment.create.mockResolvedValue(makeRow({ amount: 50 }));

      const result = await service.createScheduledPayout(creatorId, {
        amount: 50,
        recurrence: 'daily',
      } as any);

      expect(result.amount).toBe(50);
    });

    it('resolves a named recurrence preset to its cron expression and persists it', async () => {
      mockPrisma.scheduledPayment.create.mockResolvedValue(
        makeRow({ cronExpression: '0 0 * * 0' })
      );

      await service.createScheduledPayout(creatorId, { amount: 100, recurrence: 'weekly' } as any);

      expect(mockPrisma.scheduledPayment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ cronExpression: '0 0 * * 0' }) })
      );
    });

    it('rejects an invalid custom cron expression before persisting anything', async () => {
      await expect(
        service.createScheduledPayout(creatorId, {
          amount: 100,
          cronExpression: 'not a cron',
        } as any)
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockPrisma.scheduledPayment.create).not.toHaveBeenCalled();
    });

    it('registers a BullMQ job scheduler keyed by the new row id', async () => {
      mockPrisma.scheduledPayment.create.mockResolvedValue(makeRow({ id: 'sched-new' }));

      await service.createScheduledPayout(creatorId, { amount: 100, recurrence: 'daily' } as any);

      expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(1);
      const [jobSchedulerId, repeatOpts] = mockUpsertJobScheduler.mock.calls[0];
      expect(jobSchedulerId).toBe('sched-new');
      expect(repeatOpts).toEqual({ pattern: '0 0 * * *' });
    });
  });

  describe('pauseScheduledPayout / resumeScheduledPayout / cancelScheduledPayout', () => {
    it('pause removes the job scheduler and sets status to paused', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(makeRow({ status: 'active' }));
      mockPrisma.scheduledPayment.update.mockResolvedValue(makeRow({ status: 'paused' }));

      const result = await service.pauseScheduledPayout(creatorId, 'sched-1');

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith('sched-1');
      expect(result.status).toBe('paused');
    });

    it('pause is a no-op on the scheduler for an already-paused row (no double-remove)', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(makeRow({ status: 'paused' }));
      mockPrisma.scheduledPayment.update.mockResolvedValue(makeRow({ status: 'paused' }));

      await service.pauseScheduledPayout(creatorId, 'sched-1');

      expect(mockRemoveJobScheduler).not.toHaveBeenCalled();
    });

    it('pause rejects a cancelled schedule', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(makeRow({ status: 'cancelled' }));

      await expect(service.pauseScheduledPayout(creatorId, 'sched-1')).rejects.toBeInstanceOf(
        ValidationError
      );
      expect(mockRemoveJobScheduler).not.toHaveBeenCalled();
    });

    it('resume re-registers the job scheduler and sets status to active', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(makeRow({ status: 'paused' }));
      mockPrisma.scheduledPayment.update.mockResolvedValue(makeRow({ status: 'active' }));

      const result = await service.resumeScheduledPayout(creatorId, 'sched-1');

      expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('active');
    });

    it('resume rejects a cancelled schedule', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(makeRow({ status: 'cancelled' }));

      await expect(service.resumeScheduledPayout(creatorId, 'sched-1')).rejects.toBeInstanceOf(
        ValidationError
      );
    });

    it('cancel removes the job scheduler and sets status to cancelled', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(makeRow({ status: 'active' }));
      mockPrisma.scheduledPayment.update.mockResolvedValue(makeRow({ status: 'cancelled' }));

      const result = await service.cancelScheduledPayout(creatorId, 'sched-1');

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith('sched-1');
      expect(result.status).toBe('cancelled');
    });

    it('cancel on an already-cancelled row is idempotent (no scheduler call, no error)', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(makeRow({ status: 'cancelled' }));

      const result = await service.cancelScheduledPayout(creatorId, 'sched-1');

      expect(mockRemoveJobScheduler).not.toHaveBeenCalled();
      expect(result.status).toBe('cancelled');
    });
  });

  describe('ownership scoping', () => {
    it('throws NotFoundError when the scheduled payout belongs to a different creator', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(
        makeRow({ creatorId: 'someone-else' })
      );

      await expect(service.getScheduledPayout(creatorId, 'sched-1')).rejects.toBeInstanceOf(
        NotFoundError
      );
    });

    it('throws NotFoundError when the scheduled payout does not exist', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(null);

      await expect(service.getScheduledPayout(creatorId, 'does-not-exist')).rejects.toBeInstanceOf(
        NotFoundError
      );
    });
  });

  describe('listScheduledPayouts', () => {
    it('returns every scheduled payout for the creator', async () => {
      mockPrisma.scheduledPayment.findMany.mockResolvedValue([
        makeRow({ id: 'a' }),
        makeRow({ id: 'b' }),
      ]);

      const result = await service.listScheduledPayouts(creatorId);

      expect(result).toHaveLength(2);
      expect(mockPrisma.scheduledPayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { creatorId } })
      );
    });
  });
});
