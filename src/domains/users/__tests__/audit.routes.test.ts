import type { PrismaClient } from '@prisma/client';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerAuditLogRoutes } from '../audit.routes';

const { queryMock, recordMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  recordMock: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../services/audit.service', () => ({
  AuditService: vi.fn(() => ({ query: queryMock, record: recordMock })),
}));

let currentUser: { userId: string; email: string; role: string } | undefined;
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!currentUser) return reply.code(401).send({ error: 'Unauthorized' });
    request.user = currentUser;
  },
}));
vi.mock('../../../middleware/rbac', () => ({
  requireAdmin: async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user?.role !== 'admin') return reply.code(403).send({ error: 'Forbidden' });
  },
}));

const app = Fastify();
const prisma = { auditLog: {} };
registerAuditLogRoutes(app, prisma as unknown as PrismaClient);

afterEach(() => {
  vi.clearAllMocks();
  currentUser = undefined;
});

it('requires authentication to view own activity', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/users/me/activity' });
  expect(response.statusCode).toBe(401);
  expect(queryMock).not.toHaveBeenCalled();
});

it("returns the caller's own activity, scoped by userId", async () => {
  currentUser = { userId: 'user-1', email: 'u@example.com', role: 'fan' };
  queryMock.mockResolvedValue([{ id: 'log-1', action: 'POST /api/v1/things' }]);

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/users/me/activity',
    headers: { authorization: 'Bearer token' },
  });

  expect(response.statusCode).toBe(200);
  expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  expect(response.json().data).toEqual([{ id: 'log-1', action: 'POST /api/v1/things' }]);
});

it('forwards action/from/to/limit filters for own activity', async () => {
  currentUser = { userId: 'user-1', email: 'u@example.com', role: 'fan' };
  queryMock.mockResolvedValue([]);

  await app.inject({
    method: 'GET',
    url: '/api/v1/users/me/activity?action=login&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&limit=10',
    headers: { authorization: 'Bearer token' },
  });

  expect(queryMock).toHaveBeenCalledWith({
    userId: 'user-1',
    action: 'login',
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-02-01T00:00:00Z'),
    limit: 10,
  });
});

it('requires authentication for the admin query endpoint', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-log' });
  expect(response.statusCode).toBe(401);
  expect(queryMock).not.toHaveBeenCalled();
});

it('rejects a non-admin caller on the admin query endpoint', async () => {
  currentUser = { userId: 'user-1', email: 'u@example.com', role: 'fan' };

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/audit-log',
    headers: { authorization: 'Bearer token' },
  });

  expect(response.statusCode).toBe(403);
  expect(queryMock).not.toHaveBeenCalled();
});

it('allows an admin to query across any user', async () => {
  currentUser = { userId: 'admin-1', email: 'a@example.com', role: 'admin' };
  queryMock.mockResolvedValue([{ id: 'log-1' }]);

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/audit-log?userId=some-other-user&resource=webhook',
    headers: { authorization: 'Bearer token' },
  });

  expect(response.statusCode).toBe(200);
  expect(queryMock).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'some-other-user', resource: 'webhook' })
  );
});
