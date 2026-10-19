import type { PrismaClient } from '@prisma/client';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerCreatorAnalyticsRoutes } from '../creator-analytics.routes';

const { getAnalytics } = vi.hoisted(() => ({ getAnalytics: vi.fn() }));
vi.mock('../creator-analytics.service', () => ({
  CreatorAnalyticsService: vi.fn(() => ({ getAnalytics })),
}));
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' });
    request.user = { userId: 'user-1', email: 'user@example.com', role: 'creator' };
  },
}));

const app = Fastify();
const prisma = { creator: { findUnique: vi.fn().mockResolvedValue({ id: 'creator-1' }) } };
registerCreatorAnalyticsRoutes(app, prisma as unknown as PrismaClient);

afterEach(() => {
  vi.clearAllMocks();
});

it('requires authentication', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/creators/me/analytics' });
  expect(response.statusCode).toBe(401);
  expect(getAnalytics).not.toHaveBeenCalled();
});

it('returns analytics for the authenticated creator', async () => {
  getAnalytics.mockResolvedValue({ creatorId: 'creator-1', totalTips: 5 });
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/creators/me/analytics',
    headers: { authorization: 'Bearer token' },
  });
  expect(response.statusCode).toBe(200);
  expect(getAnalytics).toHaveBeenCalledWith('creator-1', {
    minDate: undefined,
    maxDate: undefined,
    timezone: undefined,
    topSupportersLimit: undefined,
  });
  expect(response.json().data).toEqual({ creatorId: 'creator-1', totalTips: 5 });
});

it('forwards filter query params to the service', async () => {
  getAnalytics.mockResolvedValue({});
  await app.inject({
    method: 'GET',
    url: '/api/v1/creators/me/analytics?minDate=2026-01-01&maxDate=2026-02-01&timezone=America/New_York&topSupportersLimit=5',
    headers: { authorization: 'Bearer token' },
  });
  expect(getAnalytics).toHaveBeenCalledWith('creator-1', {
    minDate: '2026-01-01',
    maxDate: '2026-02-01',
    timezone: 'America/New_York',
    topSupportersLimit: 5,
  });
});

it('returns 404 when the caller has no creator profile', async () => {
  prisma.creator.findUnique.mockResolvedValueOnce(null);
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/creators/me/analytics',
    headers: { authorization: 'Bearer token' },
  });
  expect(response.statusCode).toBe(404);
  expect(getAnalytics).not.toHaveBeenCalled();
});
