import type { PrismaClient } from '@prisma/client';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerDeveloperKeyRoutes } from '../api-key.routes';

const { createKey, listKeys, revokeKey } = vi.hoisted(() => ({
  createKey: vi.fn(),
  listKeys: vi.fn(),
  revokeKey: vi.fn(),
}));
vi.mock('../api-key.service', () => ({
  ApiKeyService: vi.fn(() => ({ createKey, listKeys, revokeKey })),
}));
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' });
    request.user = { userId: 'user-1', email: 'user@example.com', role: 'fan' };
  },
}));

const app = Fastify();
const prisma = {};
registerDeveloperKeyRoutes(app, prisma as unknown as PrismaClient);

afterEach(() => {
  vi.clearAllMocks();
});

it('requires authentication to create a key', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/developers/keys',
    payload: { name: 'x', permissions: ['a'] },
  });
  expect(response.statusCode).toBe(401);
  expect(createKey).not.toHaveBeenCalled();
});

it('creates a key for the authenticated user', async () => {
  createKey.mockResolvedValue({ id: 'key-1', key: 'dsk_live_abc' });
  const response = await app.inject({
    method: 'POST',
    url: '/api/developers/keys',
    headers: { authorization: 'Bearer token' },
    payload: { name: 'CI key', permissions: ['payments:read'] },
  });
  expect(response.statusCode).toBe(201);
  expect(createKey).toHaveBeenCalledWith('user-1', {
    name: 'CI key',
    permissions: ['payments:read'],
  });
  expect(response.json().data).toEqual({ id: 'key-1', key: 'dsk_live_abc' });
});

it('returns 400 when the service rejects the request as invalid', async () => {
  const { ValidationError } = await import('../../../utils/errors');
  createKey.mockRejectedValue(new ValidationError('name is required'));
  const response = await app.inject({
    method: 'POST',
    url: '/api/developers/keys',
    headers: { authorization: 'Bearer token' },
    payload: { name: '', permissions: [] },
  });
  expect(response.statusCode).toBe(400);
});

it('requires authentication to list keys', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/developers/keys' });
  expect(response.statusCode).toBe(401);
  expect(listKeys).not.toHaveBeenCalled();
});

it('lists keys for the authenticated user', async () => {
  listKeys.mockResolvedValue([{ id: 'key-1', name: 'CI key' }]);
  const response = await app.inject({
    method: 'GET',
    url: '/api/developers/keys',
    headers: { authorization: 'Bearer token' },
  });
  expect(response.statusCode).toBe(200);
  expect(listKeys).toHaveBeenCalledWith('user-1');
  expect(response.json().data).toEqual([{ id: 'key-1', name: 'CI key' }]);
});

it('requires authentication to revoke a key', async () => {
  const response = await app.inject({ method: 'DELETE', url: '/api/developers/keys/key-1' });
  expect(response.statusCode).toBe(401);
  expect(revokeKey).not.toHaveBeenCalled();
});

it('revokes a key for the authenticated user', async () => {
  revokeKey.mockResolvedValue({ id: 'key-1', revokedAt: '2026-01-01T00:00:00.000Z' });
  const response = await app.inject({
    method: 'DELETE',
    url: '/api/developers/keys/key-1',
    headers: { authorization: 'Bearer token' },
  });
  expect(response.statusCode).toBe(200);
  expect(revokeKey).toHaveBeenCalledWith('user-1', 'key-1');
});

it('returns 404 when revoking an unknown key', async () => {
  const { NotFoundError } = await import('../../../utils/errors');
  revokeKey.mockRejectedValue(new NotFoundError('API key not found'));
  const response = await app.inject({
    method: 'DELETE',
    url: '/api/developers/keys/missing',
    headers: { authorization: 'Bearer token' },
  });
  expect(response.statusCode).toBe(404);
});
