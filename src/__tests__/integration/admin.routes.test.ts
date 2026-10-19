import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { registerAdminRoutes } from '../../domains/admin/admin.routes';

// ── auth middleware mock ──────────────────────────────────────────────────────
// Intercept authMiddleware so tests control request.user without real JWTs.
// requireAdmin calls requireRole which calls authMiddleware internally.
const authMiddlewareMock = vi.hoisted(() => vi.fn());
vi.mock('../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
}));

// ── admin service mock ────────────────────────────────────────────────────────
vi.mock('../../domains/admin/admin.service', () => ({
  AdminService: vi.fn().mockImplementation(() => ({
    flagWallet: vi.fn().mockResolvedValue({ id: 'flag-1' }),
    unflagWallet: vi.fn().mockResolvedValue(undefined),
    freezeAccount: vi.fn().mockResolvedValue({ id: 'freeze-1' }),
    unfreezeAccount: vi.fn().mockResolvedValue(undefined),
    getModerationQueue: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  })),
}));

// ── dispute service mock ──────────────────────────────────────────────────────
const disputeServiceMocks = vi.hoisted(() => ({
  markDisputed: vi.fn().mockResolvedValue({
    payment: { id: 'p-1', status: 'disputed' },
    dispute: { status: 'open', reason: 'Fraudulent double charge' },
  }),
  resolveDispute: vi.fn().mockResolvedValue({
    payment: { id: 'p-1', status: 'refunded' },
    dispute: { status: 'resolved', resolution: 'refund' },
    refund: { id: 'ref-1', amount: 50 },
  }),
  listPayments: vi.fn().mockResolvedValue({
    payments: [{ id: 'p-1', status: 'disputed', amount: 50 }],
    total: 1,
    page: 1,
    pageSize: 20,
    totalPages: 1,
  }),
  getPayment: vi.fn().mockResolvedValue({
    id: 'p-1',
    status: 'disputed',
    amount: 50,
  }),
}));

vi.mock('../../domains/admin/dispute.service', () => ({
  DisputeService: vi.fn().mockImplementation(() => disputeServiceMocks),
}));

// ── cache mock ────────────────────────────────────────────────────────────────
vi.mock('../../lib/cache/index', () => ({
  default: { clear: vi.fn(), del: vi.fn() },
  getStats: vi.fn().mockReturnValue({}),
  getHitRate: vi.fn().mockReturnValue(0),
  resetStats: vi.fn(),
}));

vi.mock('../../lib/cache/cache-warming', () => ({
  CacheWarmer: vi.fn().mockImplementation(() => ({
    warmAll: vi.fn().mockResolvedValue(undefined),
    warmTopCreators: vi.fn().mockResolvedValue(undefined),
    warmTrendingData: vi.fn().mockResolvedValue(undefined),
    warmAnalyticsData: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../lib/requestContext', () => ({
  setRequestContextUserId: vi.fn(),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAdminRoutes(app, {} as unknown as PrismaClient);
  return app;
}

function setUser(role: string) {
  authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
    request.user = { userId: 'u-1', email: 'test@example.com', role };
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('admin routes — requireAdmin RBAC enforcement (#35)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  describe('POST /api/v1/admin/wallets/:address/flag', () => {
    it('allows admin users', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/wallets/GABC/flag',
        payload: { reason: 'spam', severity: 'low' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects regular (fan) users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/wallets/GABC/flag',
        payload: { reason: 'spam', severity: 'low' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects creator users with 403', async () => {
      setUser('creator');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/wallets/GABC/flag',
        payload: { reason: 'spam', severity: 'low' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/admin/creators/:creatorId/freeze', () => {
    it('allows admin users', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/creators/creator-1/freeze',
        payload: { reason: 'violation' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/creators/creator-1/freeze',
        payload: { reason: 'violation' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/admin/moderation', () => {
    it('allows admin users', async () => {
      setUser('admin');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/moderation' });
      expect(res.statusCode).toBe(200);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/moderation' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/admin/cache/stats', () => {
    it('allows admin users', async () => {
      setUser('admin');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/cache/stats' });
      expect(res.statusCode).toBe(200);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/cache/stats' });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Payment dispute workflow (#189) ─────────────────────────────────────────

  describe('POST /api/admin/payments/:id/dispute', () => {
    it('allows admin users to mark a payment as disputed', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/payments/pay-123/dispute',
        payload: { reason: 'Double charge confirmed by user' },
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(disputeServiceMocks.markDisputed).toHaveBeenCalledWith(
        'pay-123',
        'u-1',
        expect.objectContaining({ reason: 'Double charge confirmed by user' })
      );
    });

    it('allows versioned path /api/v1/admin/payments/:id/dispute', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/payments/pay-123/dispute',
        payload: { reason: 'Double charge' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/payments/pay-123/dispute',
        payload: { reason: 'Unauthorized attempt' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects creator users with 403', async () => {
      setUser('creator');
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/payments/pay-123/dispute',
        payload: { reason: 'Unauthorized attempt' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/admin/payments/:id/resolve', () => {
    it('allows admin users to resolve a dispute with refund action', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/payments/pay-123/resolve',
        payload: { action: 'refund', reason: 'Refund approved by compliance' },
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(disputeServiceMocks.resolveDispute).toHaveBeenCalledWith(
        'pay-123',
        'u-1',
        expect.objectContaining({ action: 'refund', reason: 'Refund approved by compliance' })
      );
    });

    it('allows admin users to resolve a dispute with approve action', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/payments/pay-123/resolve',
        payload: { action: 'approve', reason: 'Stellar transaction confirmed on explorer' },
      });
      expect(res.statusCode).toBe(200);
      expect(disputeServiceMocks.resolveDispute).toHaveBeenCalledWith(
        'pay-123',
        'u-1',
        expect.objectContaining({ action: 'approve' })
      );
    });

    it('allows admin users to resolve a dispute with reject action', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/payments/pay-123/resolve',
        payload: { action: 'reject', reason: 'False claim, user consumed media' },
      });
      expect(res.statusCode).toBe(200);
      expect(disputeServiceMocks.resolveDispute).toHaveBeenCalledWith(
        'pay-123',
        'u-1',
        expect.objectContaining({ action: 'reject' })
      );
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/payments/pay-123/resolve',
        payload: { action: 'refund', reason: 'Unauthorized' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/admin/payments (disputed payments listing)', () => {
    it('allows admin users to list payments filtered by status=disputed', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments?status=disputed&page=1&pageSize=10',
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(disputeServiceMocks.listPayments).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'disputed', page: 1, pageSize: 10 })
      );
    });

    it('allows versioned path /api/v1/admin/payments', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/payments?status=disputed',
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments?status=disputed',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/admin/payments/:id', () => {
    it('allows admin users to get payment details', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments/pay-123',
      });
      expect(res.statusCode).toBe(200);
      expect(disputeServiceMocks.getPayment).toHaveBeenCalledWith('pay-123');
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments/pay-123',
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
