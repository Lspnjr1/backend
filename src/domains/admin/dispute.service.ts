import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { AuditService } from '../../services/audit.service';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { PAYMENT_EVENT_TYPES, canTransition } from '../../lib/payments/transitions';
import { PaymentStatus } from '../../lib/payments/types';

export interface MarkDisputedInput {
  reason: string;
  notes?: string;
}

export type DisputeResolutionAction = 'approve' | 'reject' | 'refund';

export interface ResolveDisputeInput {
  action: DisputeResolutionAction;
  reason: string;
  notes?: string;
  targetStatus?: PaymentStatus;
  amount?: number;
  idempotencyKey?: string;
}

export interface ListPaymentsFilter {
  status?: string;
  page?: number;
  pageSize?: number;
  userId?: string;
  creatorId?: string;
}

export interface DisputeInfo {
  status: 'open' | 'resolved';
  reason: string;
  notes?: string | null;
  disputedBy: string;
  disputedAt: string;
  previousStatus?: string;
  resolution?: DisputeResolutionAction;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionReason?: string;
  resolutionNotes?: string | null;
}

export class DisputeService extends BaseService {
  private readonly auditService: AuditService;

  constructor(
    private readonly prisma: PrismaClient,
    auditService?: AuditService
  ) {
    super();
    this.auditService = auditService ?? new AuditService(this.prisma.auditLog as any);
  }

  /**
   * Mark a payment as disputed with reason and optional notes.
   * Records append-only PaymentEvent and AuditLog entries.
   */
  async markDisputed(paymentId: string, adminId: string, input: MarkDisputedInput) {
    return this.executeWithLogging('admin.payment.markDisputed', async () => {
      if (!input?.reason || !input.reason.trim()) {
        throw new ValidationError('Dispute reason is required');
      }

      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: { refunds: true },
      });

      if (!payment) {
        throw new NotFoundError('Payment');
      }

      if (payment.status === 'disputed') {
        throw new ValidationError('Payment is already disputed');
      }

      const now = new Date();
      const existingMetadata = (payment.metadata as Record<string, unknown>) ?? {};
      const disputeMeta: DisputeInfo = {
        status: 'open',
        reason: input.reason.trim(),
        notes: input.notes?.trim() || null,
        disputedBy: adminId,
        disputedAt: now.toISOString(),
        previousStatus: payment.status,
      };

      const updatedMetadata = {
        ...existingMetadata,
        dispute: disputeMeta,
      };

      const updatedPayment = await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'disputed',
          metadata: updatedMetadata as unknown as Prisma.InputJsonValue,
        },
        include: { refunds: true },
      });

      // Record immutable PaymentEvent
      await this.prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          type: PAYMENT_EVENT_TYPES.DISPUTE_CREATED,
          actor: adminId,
          data: {
            reason: input.reason.trim(),
            notes: input.notes?.trim() || null,
            previousStatus: payment.status,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      // Record compliance AuditLog
      await this.auditService.record({
        userId: adminId,
        action: 'payment.dispute.created',
        resource: 'Payment',
        resourceId: payment.id,
        changes: {
          status: { old: payment.status, new: 'disputed' },
          dispute: { old: null, new: disputeMeta },
        },
        timestamp: now,
      });

      logger.info(
        { paymentId: payment.id, adminId, reason: input.reason },
        'Payment marked as disputed by admin'
      );

      return {
        payment: updatedPayment,
        dispute: disputeMeta,
      };
    });
  }

  /**
   * Resolve a disputed payment with approve, reject, or refund.
   * Records append-only PaymentEvent and AuditLog entries with admin ID, reason, and timestamp.
   */
  async resolveDispute(paymentId: string, adminId: string, input: ResolveDisputeInput) {
    return this.executeWithLogging('admin.payment.resolveDispute', async () => {
      const allowedActions: DisputeResolutionAction[] = ['approve', 'reject', 'refund'];
      if (!input?.action || !allowedActions.includes(input.action)) {
        throw new ValidationError('Resolution action must be one of: approve, reject, refund');
      }

      if (!input?.reason || !input.reason.trim()) {
        throw new ValidationError('Resolution reason is required');
      }

      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: { refunds: true },
      });

      if (!payment) {
        throw new NotFoundError('Payment');
      }

      if (payment.status !== 'disputed') {
        throw new ValidationError('Payment is not currently disputed');
      }

      const now = new Date();
      let nextStatus: PaymentStatus;
      let createdRefund: unknown = null;

      if (input.action === 'refund') {
        const alreadyRefunded = (payment.refunds ?? [])
          .filter((r) => r.status === undefined || r.status === 'succeeded')
          .reduce((sum, r) => sum + r.amount, 0);

        const remaining = payment.amount - alreadyRefunded;
        const refundAmount = input.amount !== undefined ? input.amount : remaining;

        if (refundAmount <= 0) {
          throw new ValidationError('Nothing left to refund on this payment');
        }

        if (refundAmount > remaining) {
          throw new ValidationError(`Refund amount exceeds refundable balance of ${remaining}`);
        }

        const refundKey = input.idempotencyKey ?? randomUUID();
        const refund = await this.prisma.refund.create({
          data: {
            paymentId: payment.id,
            idempotencyKey: refundKey,
            amount: refundAmount,
            currency: payment.currency,
            reason: input.reason.trim(),
            status: 'succeeded',
          },
        });
        createdRefund = refund;

        const totalRefunded = alreadyRefunded + refundAmount;
        nextStatus = totalRefunded >= payment.amount ? 'refunded' : 'partially_refunded';

        await this.prisma.paymentEvent.create({
          data: {
            paymentId: payment.id,
            type: PAYMENT_EVENT_TYPES.REFUND_CREATED,
            actor: adminId,
            data: {
              action: 'refund',
              refundId: refund.id,
              amount: refundAmount,
              reason: input.reason.trim(),
              notes: input.notes?.trim() || null,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } else if (input.action === 'approve') {
        nextStatus = input.targetStatus ?? 'succeeded';

        await this.prisma.paymentEvent.create({
          data: {
            paymentId: payment.id,
            type: PAYMENT_EVENT_TYPES.DISPUTE_APPROVED,
            actor: adminId,
            data: {
              action: 'approve',
              reason: input.reason.trim(),
              notes: input.notes?.trim() || null,
              resolvedStatus: nextStatus,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } else {
        // action === 'reject'
        nextStatus = input.targetStatus ?? 'succeeded';

        await this.prisma.paymentEvent.create({
          data: {
            paymentId: payment.id,
            type: PAYMENT_EVENT_TYPES.DISPUTE_REJECTED,
            actor: adminId,
            data: {
              action: 'reject',
              reason: input.reason.trim(),
              notes: input.notes?.trim() || null,
              resolvedStatus: nextStatus,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }

      const existingMetadata = (payment.metadata as Record<string, unknown>) ?? {};
      const existingDispute = (existingMetadata.dispute as Record<string, unknown>) ?? {};

      const disputeMeta: DisputeInfo = {
        ...(existingDispute as unknown as DisputeInfo),
        status: 'resolved',
        resolution: input.action,
        resolvedBy: adminId,
        resolvedAt: now.toISOString(),
        resolutionReason: input.reason.trim(),
        resolutionNotes: input.notes?.trim() || null,
      };

      const updatedMetadata = {
        ...existingMetadata,
        dispute: disputeMeta,
      };

      const updatedPayment = await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: nextStatus,
          metadata: updatedMetadata as unknown as Prisma.InputJsonValue,
        },
        include: { refunds: true },
      });

      // Immutable Audit trail
      await this.auditService.record({
        userId: adminId,
        action: `payment.dispute.${input.action}`,
        resource: 'Payment',
        resourceId: payment.id,
        changes: {
          status: { old: 'disputed', new: nextStatus },
          resolution: {
            old: null,
            new: {
              action: input.action,
              reason: input.reason.trim(),
              adminId,
            },
          },
        },
        timestamp: now,
      });

      logger.info(
        {
          paymentId: payment.id,
          adminId,
          action: input.action,
          reason: input.reason,
          nextStatus,
        },
        'Payment dispute resolved by admin'
      );

      return {
        payment: updatedPayment,
        dispute: disputeMeta,
        refund: createdRefund,
      };
    });
  }

  /**
   * List payments with filtering support (e.g. status='disputed').
   * Used by admin reconciliation views.
   */
  async listPayments(filters: ListPaymentsFilter = {}) {
    return this.executeWithLogging('admin.payment.list', async () => {
      const page = Math.max(1, filters.page ?? 1);
      const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
      const where: Record<string, unknown> = {};

      if (filters.status) {
        where.status = filters.status;
      }
      if (filters.userId) {
        where.userId = filters.userId;
      }
      if (filters.creatorId) {
        where.creatorId = filters.creatorId;
      }

      const [payments, total] = await Promise.all([
        this.prisma.payment.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: { refunds: true },
        }),
        this.prisma.payment.count({ where }),
      ]);

      return {
        payments,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    });
  }

  /**
   * Get single payment details with refunds and events for admin investigation.
   */
  async getPayment(paymentId: string) {
    return this.executeWithLogging('admin.payment.get', async () => {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          refunds: true,
          events: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!payment) {
        throw new NotFoundError('Payment');
      }

      return payment;
    });
  }
}
