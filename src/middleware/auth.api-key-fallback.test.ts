import Fastify, { FastifyRequest } from 'fastify';
import { describe, expect, it, afterEach, vi } from 'vitest';

const { verifyApiKey } = vi.hoisted(() => ({ verifyApiKey: vi.fn() }));
vi.mock('../domains/developers/api-key-auth', () => ({ verifyApiKey }));

const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));
vi.mock('../utils/jwt', () => ({ verifyToken }));

const { isTokenBlacklisted, isUserAuthVersionCurrent } = vi.hoisted(() => ({
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  isUserAuthVersionCurrent: vi.fn().mockResolvedValue(true),
}));
vi.mock('../utils/token-blacklist', () => ({ isTokenBlacklisted, isUserAuthVersionCurrent }));

vi.mock('../lib/requestContext', () => ({ setRequestContextUserId: vi.fn() }));

import { authMiddleware } from './auth';

function app() {
  const server = Fastify({ logger: false });
  server.get('/protected', { preHandler: authMiddleware }, async (request: FastifyRequest) => ({
    userId: request.user?.userId,
    apiKeyId: request.apiKey?.apiKeyId,
    permissions: request.apiKey?.permissions,
  }));
  return server;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('authMiddleware API key fallback (issue #213)', () => {
  it('authenticates a request bearing a valid API key, never touching JWT verification', async () => {
    verifyApiKey.mockResolvedValue({
      apiKeyId: 'key-1',
      userId: 'user-1',
      permissions: ['payments:read'],
    });

    const response = await app().inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer dsk_live_abcdef0123456789' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: 'user-1',
      apiKeyId: 'key-1',
      permissions: ['payments:read'],
    });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid or revoked API key without falling through to JWT verification', async () => {
    verifyApiKey.mockResolvedValue(null);

    const response = await app().inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer dsk_live_invalidinvalidinvalid' },
    });

    expect(response.statusCode).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('falls through to JWT verification for a bearer token without the API key prefix', async () => {
    verifyToken.mockReturnValue({
      userId: 'user-2',
      email: 'u@example.com',
      role: 'fan',
      authVersion: 0,
    });

    const response = await app().inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer some.jwt.token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().userId).toBe('user-2');
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it('forwards method, path, and ip to the API key verifier for usage logging', async () => {
    verifyApiKey.mockResolvedValue({ apiKeyId: 'key-1', userId: 'user-1', permissions: [] });

    await app().inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer dsk_live_abcdef0123456789' },
    });

    expect(verifyApiKey).toHaveBeenCalledWith(
      'dsk_live_abcdef0123456789',
      expect.objectContaining({ method: 'GET', path: '/protected' })
    );
  });

  it('rejects a missing authorization header regardless of the API key fallback', async () => {
    const response = await app().inject({ method: 'GET', url: '/protected' });
    expect(response.statusCode).toBe(401);
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
  });
});
