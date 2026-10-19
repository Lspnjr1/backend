import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisputeService } from '../dispute.service';
import { NotFoundError, ValidationError } from '../../../utils/errors';
import { PAYMENT_EVENT_TYPES } from '../../../lib/payments/transitions';

describe('DisputeService', () => {
  let prismaMock: any;
  let auditServiceMock: any;
  let disputeService: DisputeService;

  const mockAdminId = 'admin-user-123';
  const mockPaymentId = 'pay-abc-456';

  const basePayment = {
    id: mockPaymentId,
    idempotencyKey: 'idem-1',
    userId: 'user-789',
    creatorId: 'creator-999',
    provider: 'stripe',
    method: 'card',
    providerRef: 'pi_test123',
    amount: 100,
    currency: 'USD',
    status: 'succeeded',
    description: 'Test payment',
    metadata: {},
    createdAt: new Date('2026-10-01T12:00:00Z'),
    updatedAt: new Date('2026-10-01T12:00:00Z'),
    refunds: [],
  };

  beforeEach(() => {
    prismaMock = {
      payment: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
      paymentEvent: {
        create: vi.fn().mockResolvedValue({ id: 'pe-1' }),
      },
      refund: {
        create: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
    };

    auditServiceMock = {
      record: vi.fn().mockResolvedValue({ id: 'audit-log-1' }),
    };

    disputeService = new DisputeService(prismaMock, auditServiceMock);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // markDisputed
  // ───────────────────────────────────────────────────────────────────────────
  describe('markDisputed', () => {
    it('marks a succeeded payment as disputed with reason and logs audit trail', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({ ...basePayment });
      prismaMock.payment.update.mockImplementation(async ({ data }: any) => ({
        ...basePayment,
        ...data,
      }));

      const result = await disputeService.markDisputed(mockPaymentId, mockAdminId, {
        reason: 'Double charged customer',
        notes: 'User reported two charges on credit card statement',
      });

      expect(result.payment.status).toBe('disputed');
      expect(result.dispute.status).toBe('open');
      expect(result.dispute.reason).toBe('Double charged customer');
      expect(result.dispute.notes).toBe('User reported two charges on credit card statement');
      expect(result.dispute.disputedBy).toBe(mockAdminId);
      expect(result.dispute.previousStatus).toBe('succeeded');
      expect(result.dispute.disputedAt).toBeDefined();

      // Verify Prisma payment.update called with disputed status and merged metadata
      expect(prismaMock.payment.update).toHaveBeenCalledWith({
        where: { id: mockPaymentId },
        data: {
          status: 'disputed',
          metadata: expect.objectContaining({
            dispute: expect.objectContaining({
              status: 'open',
              reason: 'Double charged customer',
              disputedBy: mockAdminId,
            }),
          }),
        },
        include: { refunds: true },
      });

      // Verify PaymentEvent created
      expect(prismaMock.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: mockPaymentId,
          type: PAYMENT_EVENT_TYPES.DISPUTE_CREATED,
          actor: mockAdminId,
          data: {
            reason: 'Double charged customer',
            notes: 'User reported two charges on credit card statement',
            previousStatus: 'succeeded',
          },
        },
      });

      // Verify AuditService record called
      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockAdminId,
          action: 'payment.dispute.created',
          resource: 'Payment',
          resourceId: mockPaymentId,
          changes: expect.objectContaining({
            status: { old: 'succeeded', new: 'disputed' },
            dispute: expect.objectContaining({
              old: null,
              new: expect.objectContaining({
                reason: 'Double charged customer',
                disputedBy: mockAdminId,
              }),
            }),
          }),
        })
      );
    });

    it('throws ValidationError when dispute reason is missing or whitespace', async () => {
      await expect(
        disputeService.markDisputed(mockPaymentId, mockAdminId, { reason: '   ' })
      ).rejects.toThrow(ValidationError);

      expect(prismaMock.payment.update).not.toHaveBeenCalled();
      expect(auditServiceMock.record).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when payment does not exist', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(null);

      await expect(
        disputeService.markDisputed('non-existent-id', mockAdminId, { reason: 'Double charge' })
      ).rejects.toThrow(NotFoundError);

      expect(prismaMock.payment.update).not.toHaveBeenCalled();
    });

    it('throws ValidationError when payment is already disputed', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({
        ...basePayment,
        status: 'disputed',
        metadata: { dispute: { status: 'open', reason: 'Earlier dispute' } },
      });

      await expect(
        disputeService.markDisputed(mockPaymentId, mockAdminId, { reason: 'Another dispute' })
      ).rejects.toThrow(ValidationError);

      expect(prismaMock.payment.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // resolveDispute
  // ───────────────────────────────────────────────────────────────────────────
  describe('resolveDispute', () => {
    const disputedPayment = {
      ...basePayment,
      status: 'disputed',
      metadata: {
        dispute: {
          status: 'open',
          reason: 'Double charged',
          disputedBy: mockAdminId,
          disputedAt: '2026-10-02T10:00:00.000Z',
          previousStatus: 'succeeded',
        },
      },
    };

    it('resolves dispute with action "refund", creates Refund record and logs audit trail', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({ ...disputedPayment });
      prismaMock.refund.create.mockResolvedValue({
        id: 'refund-1',
        paymentId: mockPaymentId,
        amount: 100,
        currency: 'USD',
        reason: 'Refunded due to verified double charge',
        status: 'succeeded',
        idempotencyKey: 'refund-idem-key',
      });
      prismaMock.payment.update.mockImplementation(async ({ data }: any) => ({
        ...disputedPayment,
        ...data,
      }));

      const result = await disputeService.resolveDispute(mockPaymentId, mockAdminId, {
        action: 'refund',
        reason: 'Refunded due to verified double charge',
        notes: 'Card provider confirmed duplicate intent',
      });

      expect(result.payment.status).toBe('refunded');
      expect(result.dispute.status).toBe('resolved');
      expect(result.dispute.resolution).toBe('refund');
      expect(result.dispute.resolvedBy).toBe(mockAdminId);
      expect(result.dispute.resolutionReason).toBe('Refunded due to verified double charge');
      expect(result.refund).toBeDefined();

      // Verify refund record created
      expect(prismaMock.refund.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          paymentId: mockPaymentId,
          amount: 100,
          currency: 'USD',
          reason: 'Refunded due to verified double charge',
          status: 'succeeded',
        }),
      });

      // Verify payment.update called
      expect(prismaMock.payment.update).toHaveBeenCalledWith({
        where: { id: mockPaymentId },
        data: {
          status: 'refunded',
          metadata: expect.objectContaining({
            dispute: expect.objectContaining({
              status: 'resolved',
              resolution: 'refund',
              resolvedBy: mockAdminId,
            }),
          }),
        },
        include: { refunds: true },
      });

      // Verify PaymentEvent for refund
      expect(prismaMock.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: mockPaymentId,
          type: PAYMENT_EVENT_TYPES.REFUND_CREATED,
          actor: mockAdminId,
          data: expect.objectContaining({
            action: 'refund',
            amount: 100,
            reason: 'Refunded due to verified double charge',
          }),
        },
      });

      // Verify AuditService logged the refund resolution
      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockAdminId,
          action: 'payment.dispute.refund',
          resource: 'Payment',
          resourceId: mockPaymentId,
          changes: expect.objectContaining({
            status: { old: 'disputed', new: 'refunded' },
            resolution: expect.objectContaining({
              new: expect.objectContaining({
                action: 'refund',
                reason: 'Refunded due to verified double charge',
                adminId: mockAdminId,
              }),
            }),
          }),
        })
      );
    });

    it('resolves dispute with partial refund when amount is specified', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({
        ...disputedPayment,
        amount: 100,
        refunds: [],
      });
      prismaMock.refund.create.mockResolvedValue({
        id: 'refund-partial',
        paymentId: mockPaymentId,
        amount: 40,
        currency: 'USD',
        reason: 'Partial adjustment',
        status: 'succeeded',
      });
      prismaMock.payment.update.mockImplementation(async ({ data }: any) => ({
        ...disputedPayment,
        ...data,
      }));

      const result = await disputeService.resolveDispute(mockPaymentId, mockAdminId, {
        action: 'refund',
        amount: 40,
        reason: 'Partial adjustment',
      });

      expect(result.payment.status).toBe('partially_refunded');
      expect(prismaMock.refund.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: 40,
        }),
      });
    });

    it('throws ValidationError on refund when payment is already fully refunded', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({
        ...disputedPayment,
        amount: 100,
        refunds: [{ amount: 100, status: 'succeeded' }],
      });

      await expect(
        disputeService.resolveDispute(mockPaymentId, mockAdminId, {
          action: 'refund',
          reason: 'Try to refund again',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('resolves dispute with action "approve" and updates payment to succeeded', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({ ...disputedPayment });
      prismaMock.payment.update.mockImplementation(async ({ data }: any) => ({
        ...disputedPayment,
        ...data,
      }));

      const result = await disputeService.resolveDispute(mockPaymentId, mockAdminId, {
        action: 'approve',
        reason: 'Verified blockchain transaction, confirmed tip to creator',
        notes: 'Hash validated on Stellar horizon explorer',
      });

      expect(result.payment.status).toBe('succeeded');
      expect(result.dispute.status).toBe('resolved');
      expect(result.dispute.resolution).toBe('approve');
      expect(result.dispute.resolutionReason).toBe(
        'Verified blockchain transaction, confirmed tip to creator'
      );
      expect(result.dispute.resolvedBy).toBe(mockAdminId);

      // Verify PaymentEvent
      expect(prismaMock.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: mockPaymentId,
          type: PAYMENT_EVENT_TYPES.DISPUTE_APPROVED,
          actor: mockAdminId,
          data: expect.objectContaining({
            action: 'approve',
            reason: 'Verified blockchain transaction, confirmed tip to creator',
            resolvedStatus: 'succeeded',
          }),
        },
      });

      // Verify AuditService
      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockAdminId,
          action: 'payment.dispute.approve',
          resource: 'Payment',
          resourceId: mockPaymentId,
        })
      );
    });

    it('resolves dispute with action "reject" and logs dispute rejection audit trail', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({ ...disputedPayment });
      prismaMock.payment.update.mockImplementation(async ({ data }: any) => ({
        ...disputedPayment,
        ...data,
      }));

      const result = await disputeService.resolveDispute(mockPaymentId, mockAdminId, {
        action: 'reject',
        reason: 'Dispute unfounded, cardholder signed authorization',
        notes: 'Submitted signed proof to merchant processor',
      });

      expect(result.payment.status).toBe('succeeded');
      expect(result.dispute.status).toBe('resolved');
      expect(result.dispute.resolution).toBe('reject');
      expect(result.dispute.resolvedBy).toBe(mockAdminId);

      // Verify PaymentEvent
      expect(prismaMock.paymentEvent.create).toHaveBeenCalledWith({
        data: {
          paymentId: mockPaymentId,
          type: PAYMENT_EVENT_TYPES.DISPUTE_REJECTED,
          actor: mockAdminId,
          data: expect.objectContaining({
            action: 'reject',
            reason: 'Dispute unfounded, cardholder signed authorization',
          }),
        },
      });

      // Verify AuditService
      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockAdminId,
          action: 'payment.dispute.reject',
          resource: 'Payment',
          resourceId: mockPaymentId,
        })
      );
    });

    it('throws ValidationError when action is invalid', async () => {
      await expect(
        disputeService.resolveDispute(mockPaymentId, mockAdminId, {
          action: 'invalid_action' as any,
          reason: 'Test',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when reason is empty', async () => {
      await expect(
        disputeService.resolveDispute(mockPaymentId, mockAdminId, {
          action: 'approve',
          reason: '   ',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when payment does not exist', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(null);

      await expect(
        disputeService.resolveDispute('non-existent', mockAdminId, {
          action: 'approve',
          reason: 'Valid',
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError when payment is not in disputed status', async () => {
      prismaMock.payment.findUnique.mockResolvedValue({
        ...basePayment,
        status: 'succeeded',
      });

      await expect(
        disputeService.resolveDispute(mockPaymentId, mockAdminId, {
          action: 'approve',
          reason: 'Payment already succeeded',
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // listPayments (filtering by status)
  // ───────────────────────────────────────────────────────────────────────────
  describe('listPayments', () => {
    it('lists payments filtered by status=disputed', async () => {
      const mockPayments = [
        { ...basePayment, id: 'pay-1', status: 'disputed' },
        { ...basePayment, id: 'pay-2', status: 'disputed' },
      ];
      prismaMock.payment.findMany.mockResolvedValue(mockPayments);
      prismaMock.payment.count.mockResolvedValue(2);

      const result = await disputeService.listPayments({
        status: 'disputed',
        page: 1,
        pageSize: 10,
      });

      expect(prismaMock.payment.findMany).toHaveBeenCalledWith({
        where: { status: 'disputed' },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { refunds: true },
      });
      expect(result.payments).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.totalPages).toBe(1);
    });

    it('supports pagination defaults', async () => {
      prismaMock.payment.findMany.mockResolvedValue([]);
      prismaMock.payment.count.mockResolvedValue(0);

      const result = await disputeService.listPayments({});

      expect(prismaMock.payment.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: { refunds: true },
      });
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getPayment
  // ───────────────────────────────────────────────────────────────────────────
  describe('getPayment', () => {
    it('returns payment with refunds and events', async () => {
      const mockWithEvents = {
        ...basePayment,
        refunds: [],
        events: [{ id: 'evt-1', type: 'payment.disputed' }],
      };
      prismaMock.payment.findUnique.mockResolvedValue(mockWithEvents);

      const result = await disputeService.getPayment(mockPaymentId);

      expect(result.id).toBe(mockPaymentId);
      expect(prismaMock.payment.findUnique).toHaveBeenCalledWith({
        where: { id: mockPaymentId },
        include: {
          refunds: true,
          events: { orderBy: { createdAt: 'desc' } },
        },
      });
    });

    it('throws NotFoundError when payment does not exist', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(null);

      await expect(disputeService.getPayment('non-existent')).rejects.toThrow(NotFoundError);
    });
  });
});
