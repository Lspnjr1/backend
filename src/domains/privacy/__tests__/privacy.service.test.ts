import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Stub the BullMQ queue so the service can be imported/exercised without Redis.
vi.mock('../../../lib/queue', () => ({
  accountDeletionQueue: { add: vi.fn(), remove: vi.fn() },
}));

// Stub email enqueueing: these tests assert the deletion/cancellation
// behavior, not delivery.
vi.mock('../../notifications/email', () => ({
  enqueueEmail: vi.fn().mockResolvedValue('job-1'),
}));

vi.mock('../../../utils/password', () => ({
  comparePasswords: vi.fn(),
  hashPassword: vi.fn(),
}));

import { PrivacyService, DELETION_GRACE_PERIOD_DAYS } from '../privacy.service';
import { accountDeletionQueue } from '../../../lib/queue';
import { enqueueEmail } from '../../notifications/email';
import { comparePasswords } from '../../../utils/password';
import { ConflictError, UnauthorizedError, ValidationError } from '../../../utils/errors';

const mockAdd = accountDeletionQueue.add as ReturnType<typeof vi.fn>;
const mockRemove = accountDeletionQueue.remove as ReturnType<typeof vi.fn>;
const mockEnqueueEmail = enqueueEmail as ReturnType<typeof vi.fn>;
const mockComparePasswords = comparePasswords as ReturnType<typeof vi.fn>;

/**
 * Regression tests for issue #220 (GDPR account deletion).
 *
 * `DELETION_GRACE_PERIOD_DAYS` is asserted against the literal `30` from the
 * issue's acceptance criteria, not just "whatever the constant currently is",
 * so a future accidental change to the grace period is caught here too.
 */
describe('PrivacyService — scheduled account deletion (#220)', () => {
  const userId = 'user-1';
  let mockPrisma: any;
  let service: PrivacyService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = {
      user: { findUnique: vi.fn(), update: vi.fn() },
      wallet: { deleteMany: vi.fn() },
      scheduledAccountDeletion: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn((ops: any[]) => Promise.all(ops)),
    };
    service = new PrivacyService(mockPrisma);

    mockPrisma.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      name: 'Test User',
      password: 'hashed-password',
    });
    mockPrisma.scheduledAccountDeletion.findFirst.mockResolvedValue(null);
    mockComparePasswords.mockResolvedValue(true);
  });

  it('asserts the grace period is exactly 30 days (issue acceptance criteria literal)', () => {
    expect(DELETION_GRACE_PERIOD_DAYS).toBe(30);
  });

  describe('requestDeletion', () => {
    it('rejects an incorrect password without scheduling anything', async () => {
      mockComparePasswords.mockResolvedValue(false);

      await expect(service.requestDeletion(userId, 'wrong-password')).rejects.toBeInstanceOf(
        UnauthorizedError
      );
      expect(mockPrisma.scheduledAccountDeletion.create).not.toHaveBeenCalled();
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('schedules deletion exactly 30 days out (literal 30-day check) on a correct password', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      mockPrisma.scheduledAccountDeletion.create.mockImplementation(({ data }: any) => ({
        id: 'sched-1',
        ...data,
      }));

      vi.setSystemTime(createdAt);
      const result = await service.requestDeletion(userId, 'correct-password');
      vi.useRealTimers();

      const expectedScheduledFor = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      expect(result.scheduledFor).toBe(expectedScheduledFor.toISOString());
      expect(result.status).toBe('pending');
    });

    it('enqueues a delayed job keyed by the scheduled deletion id with a 30-day delay in milliseconds', async () => {
      mockPrisma.scheduledAccountDeletion.create.mockResolvedValue({
        id: 'sched-2',
        userId,
        status: 'pending',
        requestedAt: new Date(),
        scheduledFor: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        cancelledAt: null,
      });

      await service.requestDeletion(userId, 'correct-password');

      expect(mockAdd).toHaveBeenCalledTimes(1);
      const [, , opts] = mockAdd.mock.calls[0];
      expect(opts.jobId).toBe('sched-2');
      expect(opts.delay).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('sends a confirmation email containing a cancellation link', async () => {
      mockPrisma.scheduledAccountDeletion.create.mockResolvedValue({
        id: 'sched-3',
        userId,
        status: 'pending',
        requestedAt: new Date(),
        scheduledFor: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        cancelledAt: null,
      });

      await service.requestDeletion(userId, 'correct-password');

      expect(mockEnqueueEmail).toHaveBeenCalledTimes(1);
      const [payload] = mockEnqueueEmail.mock.calls[0];
      expect(payload.template).toBe('account-deletion-scheduled');
      expect(payload.data.link).toContain('token=');
    });

    it('is idempotent: a second request while one is already pending returns the existing schedule instead of creating a duplicate', async () => {
      const existing = {
        id: 'sched-existing',
        userId,
        status: 'pending',
        requestedAt: new Date('2026-01-01T00:00:00.000Z'),
        scheduledFor: new Date('2026-01-31T00:00:00.000Z'),
        cancelledAt: null,
      };
      mockPrisma.scheduledAccountDeletion.findFirst.mockResolvedValue(existing);

      const result = await service.requestDeletion(userId, 'correct-password');

      expect(result.id).toBe('sched-existing');
      expect(mockPrisma.scheduledAccountDeletion.create).not.toHaveBeenCalled();
      expect(mockAdd).not.toHaveBeenCalled();
    });
  });

  describe('cancelDeletionByToken', () => {
    it('rejects an unknown token', async () => {
      mockPrisma.scheduledAccountDeletion.findUnique.mockResolvedValue(null);

      await expect(service.cancelDeletionByToken('bogus-token')).rejects.toBeInstanceOf(
        ValidationError
      );
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('rejects a token for a deletion that is no longer pending', async () => {
      mockPrisma.scheduledAccountDeletion.findUnique.mockResolvedValue({
        id: 'sched-4',
        userId,
        status: 'completed',
        requestedAt: new Date(),
        scheduledFor: new Date(Date.now() - 1000),
        cancelledAt: null,
      });

      await expect(service.cancelDeletionByToken('some-token')).rejects.toBeInstanceOf(
        ValidationError
      );
    });

    it('rejects cancellation once scheduledFor has already passed', async () => {
      mockPrisma.scheduledAccountDeletion.findUnique.mockResolvedValue({
        id: 'sched-5',
        userId,
        status: 'pending',
        requestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        scheduledFor: new Date(Date.now() - 1000),
        cancelledAt: null,
      });

      await expect(service.cancelDeletionByToken('some-token')).rejects.toBeInstanceOf(
        ConflictError
      );
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('cancels a valid pending deletion and removes the queued job by id', async () => {
      mockPrisma.scheduledAccountDeletion.findUnique.mockResolvedValue({
        id: 'sched-6',
        userId,
        status: 'pending',
        requestedAt: new Date(),
        scheduledFor: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
        cancelledAt: null,
      });
      mockPrisma.scheduledAccountDeletion.update.mockImplementation(({ data }: any) => ({
        id: 'sched-6',
        userId,
        requestedAt: new Date(),
        scheduledFor: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
        ...data,
      }));

      const result = await service.cancelDeletionByToken('valid-token');

      expect(mockRemove).toHaveBeenCalledWith('sched-6');
      expect(result.status).toBe('cancelled');
      expect(result.cancelledAt).not.toBeNull();
    });

    it('the stored cancellationTokenHash is a sha256 digest of the raw token, never the raw token itself', async () => {
      mockPrisma.scheduledAccountDeletion.create.mockResolvedValue({
        id: 'sched-7',
        userId,
        status: 'pending',
        requestedAt: new Date(),
        scheduledFor: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        cancelledAt: null,
      });

      await service.requestDeletion(userId, 'correct-password');

      const createCall = mockPrisma.scheduledAccountDeletion.create.mock.calls[0][0];
      const storedHash = createCall.data.cancellationTokenHash;
      const link: string = mockEnqueueEmail.mock.calls[0][0].data.link;
      const rawToken = new URL(link).searchParams.get('token')!;

      expect(storedHash).not.toBe(rawToken);
      expect(storedHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    });
  });

  describe('executeScheduledDeletion', () => {
    it('tombstones the user and deletes wallets when the deletion is still pending', async () => {
      mockPrisma.scheduledAccountDeletion.findUnique.mockResolvedValue({
        id: 'sched-8',
        userId,
        status: 'pending',
      });

      await service.executeScheduledDeletion('sched-8');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.wallet.deleteMany).toHaveBeenCalledWith({ where: { userId } });
      const userUpdateArgs = mockPrisma.user.update.mock.calls[0][0];
      expect(userUpdateArgs.data.email).toContain('deleted-');
      expect(userUpdateArgs.data.name).toBeNull();
    });

    it('is a no-op when the deletion was already cancelled (race between cancel and worker pickup)', async () => {
      mockPrisma.scheduledAccountDeletion.findUnique.mockResolvedValue({
        id: 'sched-9',
        userId,
        status: 'cancelled',
      });

      await service.executeScheduledDeletion('sched-9');

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('is a no-op when the deletion id does not exist', async () => {
      mockPrisma.scheduledAccountDeletion.findUnique.mockResolvedValue(null);

      await service.executeScheduledDeletion('does-not-exist');

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
