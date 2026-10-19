import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { registerAdminRoutes } from '../admin.routes';

// Mock auth middleware to control user role and id
const authMiddlewareMock = vi.hoisted(() => vi.fn());
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
}));

// Mock cache
vi.mock('../../../lib/cache/index', () => ({
  default: { clear: vi.fn(), del: vi.fn() },
  getStats: vi.fn().mockReturnValue({}),
  getHitRate: vi.fn().mockReturnValue(0),
  resetStats: vi.fn(),
}));

vi.mock('../../../lib/cache/cache-warming', () => ({
  CacheWarmer: vi.fn().mockImplementation(() => ({
    warmAll: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../lib/requestContext', () => ({
  setRequestContextUserId: vi.fn(),
  getRequestContext: vi.fn().mockReturnValue(undefined),
  runWithContext: vi.fn((_ctx, fn) => fn()),
}));

describe('Admin Payment Dispute Routes — End-to-End Workflow (#189)', () => {
  let app: FastifyInstance;
  let inMemoryPayments: Map<string, any>;
  let inMemoryEvents: any[];
  let inMemoryRefunds: any[];
  let inMemoryAuditLogs: any[];
  let prismaMock: any;

  beforeEach(() => {
    vi.clearAllMocks();

    inMemoryPayments = new Map();
    inMemoryEvents = [];
    inMemoryRefunds = [];
    inMemoryAuditLogs = [];

    // Seed a standard succeeded payment
    inMemoryPayments.set('pay-100', {
      id: 'pay-100',
      idempotencyKey: 'idem-100',
      userId: 'user-fan-1',
      creatorId: 'creator-1',
      provider: 'stripe',
      method: 'card',
      providerRef: 'pi_100',
      amount: 150,
      currency: 'USD',
      status: 'succeeded',
      description: 'Fan tip payment',
      metadata: {},
      createdAt: new Date('2026-10-10T10:00:00Z'),
      updatedAt: new Date('2026-10-10T10:00:00Z'),
    });

    prismaMock = {
      payment: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          const p = inMemoryPayments.get(where.id);
          if (!p) return null;
          return {
            ...p,
            refunds: inMemoryRefunds.filter((r) => r.paymentId === where.id),
          };
        }),
        findMany: vi.fn().mockImplementation(async ({ where, skip = 0, take = 20 }: any) => {
          let list = Array.from(inMemoryPayments.values());
          if (where?.status) {
            list = list.filter((p) => p.status === where.status);
          }
          if (where?.userId) {
            list = list.filter((p) => p.userId === where.userId);
          }
          return list.slice(skip, skip + take).map((p) => ({
            ...p,
            refunds: inMemoryRefunds.filter((r) => r.paymentId === p.id),
          }));
        }),
        count: vi.fn().mockImplementation(async ({ where }: any) => {
          let list = Array.from(inMemoryPayments.values());
          if (where?.status) {
            list = list.filter((p) => p.status === where.status);
          }
          return list.length;
        }),
        update: vi.fn().mockImplementation(async ({ where, data }: any) => {
          const existing = inMemoryPayments.get(where.id);
          if (!existing) throw new Error('Payment not found');
          const updated = {
            ...existing,
            ...data,
            updatedAt: new Date(),
          };
          inMemoryPayments.set(where.id, updated);
          return {
            ...updated,
            refunds: inMemoryRefunds.filter((r) => r.paymentId === where.id),
          };
        }),
      },
      paymentEvent: {
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          const event = { id: `pe-${inMemoryEvents.length + 1}`, ...data, createdAt: new Date() };
          inMemoryEvents.push(event);
          return event;
        }),
      },
      refund: {
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          const ref = { id: `ref-${inMemoryRefunds.length + 1}`, ...data, createdAt: new Date() };
          inMemoryRefunds.push(ref);
          return ref;
        }),
      },
      auditLog: {
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          const log = { id: `audit-${inMemoryAuditLogs.length + 1}`, ...data, timestamp: new Date() };
          inMemoryAuditLogs.push(log);
          return log;
        }),
      },
    };

    app = Fastify({ logger: false });
    registerAdminRoutes(app, prismaMock as unknown as PrismaClient);
  });

  function setAuthenticatedUser(role: string, userId = 'admin-user-1') {
    authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
      request.user = { userId, email: 'admin@dorisio.com', role };
    });
  }

  it('runs complete dispute and refund resolution lifecycle with audit trail', async () => {
    setAuthenticatedUser('admin', 'admin-bob');

    // 1. Mark payment as disputed
    const disputeRes = await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/dispute',
      payload: {
        reason: 'Double charge investigation',
        notes: 'User reported duplicate charge on card',
      },
    });

    expect(disputeRes.statusCode).toBe(200);
    const disputeBody = JSON.parse(disputeRes.payload);
    expect(disputeBody.success).toBe(true);
    expect(disputeBody.data.payment.status).toBe('disputed');
    expect(disputeBody.data.dispute.reason).toBe('Double charge investigation');
    expect(disputeBody.data.dispute.disputedBy).toBe('admin-bob');

    // Verify payment in storage is now disputed
    expect(inMemoryPayments.get('pay-100').status).toBe('disputed');

    // Verify PaymentEvent created
    expect(inMemoryEvents.some((e) => e.type === 'payment.disputed' && e.actor === 'admin-bob')).toBe(true);

    // Verify AuditLog created
    expect(
      inMemoryAuditLogs.some(
        (l) => l.action === 'payment.dispute.created' && l.userId === 'admin-bob' && l.resourceId === 'pay-100'
      )
    ).toBe(true);

    // 2. Disputed payments are visible in listing filter by status
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/admin/payments?status=disputed',
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.payload);
    expect(listBody.success).toBe(true);
    expect(listBody.data.payments).toHaveLength(1);
    expect(listBody.data.payments[0].id).toBe('pay-100');
    expect(listBody.data.payments[0].status).toBe('disputed');

    // 3. Resolve dispute with refund
    const resolveRes = await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/resolve',
      payload: {
        action: 'refund',
        reason: 'Confirmed duplicate charge from gateway',
        notes: 'Issued full refund to user card',
      },
    });

    expect(resolveRes.statusCode).toBe(200);
    const resolveBody = JSON.parse(resolveRes.payload);
    expect(resolveBody.success).toBe(true);
    expect(resolveBody.data.payment.status).toBe('refunded');
    expect(resolveBody.data.dispute.resolution).toBe('refund');
    expect(resolveBody.data.dispute.resolvedBy).toBe('admin-bob');
    expect(resolveBody.data.refund.amount).toBe(150);

    // Verify payment in storage is refunded
    expect(inMemoryPayments.get('pay-100').status).toBe('refunded');

    // Verify Refund record created
    expect(inMemoryRefunds).toHaveLength(1);
    expect(inMemoryRefunds[0].amount).toBe(150);
    expect(inMemoryRefunds[0].status).toBe('succeeded');

    // Verify AuditLog contains resolve action with admin ID, timestamp, reason
    const resolveAudit = inMemoryAuditLogs.find(
      (l) => l.action === 'payment.dispute.refund' && l.userId === 'admin-bob'
    );
    expect(resolveAudit).toBeDefined();
    expect(resolveAudit.changes.status.new).toBe('refunded');
    expect(resolveAudit.changes.resolution.new.reason).toBe('Confirmed duplicate charge from gateway');
  });

  it('runs dispute and approve resolution lifecycle (false confirmation verified)', async () => {
    setAuthenticatedUser('admin', 'admin-alice');

    // Mark as disputed
    await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/dispute',
      payload: { reason: 'False confirmation check' },
    });

    // Resolve with approve
    const resolveRes = await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/resolve',
      payload: {
        action: 'approve',
        reason: 'Payment confirmed on Stellar Horizon ledger',
      },
    });

    expect(resolveRes.statusCode).toBe(200);
    const resolveBody = JSON.parse(resolveRes.payload);
    expect(resolveBody.data.payment.status).toBe('succeeded');
    expect(resolveBody.data.dispute.resolution).toBe('approve');
    expect(resolveBody.data.dispute.resolvedBy).toBe('admin-alice');

    expect(inMemoryPayments.get('pay-100').status).toBe('succeeded');
    expect(inMemoryEvents.some((e) => e.type === 'payment.dispute.approved')).toBe(true);
    expect(inMemoryAuditLogs.some((l) => l.action === 'payment.dispute.approve')).toBe(true);
  });

  it('runs dispute and reject resolution lifecycle', async () => {
    setAuthenticatedUser('admin', 'admin-carol');

    // Mark as disputed
    await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/dispute',
      payload: { reason: 'User dispute claim' },
    });

    // Resolve with reject
    const resolveRes = await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/resolve',
      payload: {
        action: 'reject',
        reason: 'Dispute dismissed, user authorized payment',
      },
    });

    expect(resolveRes.statusCode).toBe(200);
    const resolveBody = JSON.parse(resolveRes.payload);
    expect(resolveBody.data.payment.status).toBe('succeeded');
    expect(resolveBody.data.dispute.resolution).toBe('reject');
    expect(resolveBody.data.dispute.resolvedBy).toBe('admin-carol');

    expect(inMemoryPayments.get('pay-100').status).toBe('succeeded');
    expect(inMemoryEvents.some((e) => e.type === 'payment.dispute.rejected')).toBe(true);
    expect(inMemoryAuditLogs.some((l) => l.action === 'payment.dispute.reject')).toBe(true);
  });

  it('rejects attempt to dispute already disputed payment', async () => {
    setAuthenticatedUser('admin');

    await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/dispute',
      payload: { reason: 'Initial dispute' },
    });

    // Second dispute attempt
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/dispute',
      payload: { reason: 'Second dispute' },
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.payload);
    expect(json.success).toBe(false);
    expect(json.error.message).toContain('already disputed');
  });

  it('rejects attempt to resolve non-disputed payment', async () => {
    setAuthenticatedUser('admin');

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/resolve',
      payload: { action: 'approve', reason: 'Not disputed yet' },
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.payload);
    expect(json.success).toBe(false);
    expect(json.error.message).toContain('not currently disputed');
  });

  it('rejects non-admin requests with 403', async () => {
    setAuthenticatedUser('fan');

    const disputeRes = await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/dispute',
      payload: { reason: 'Unauthorized dispute' },
    });
    expect(disputeRes.statusCode).toBe(403);

    const resolveRes = await app.inject({
      method: 'POST',
      url: '/api/admin/payments/pay-100/resolve',
      payload: { action: 'refund', reason: 'Unauthorized resolve' },
    });
    expect(resolveRes.statusCode).toBe(403);
  });
});
