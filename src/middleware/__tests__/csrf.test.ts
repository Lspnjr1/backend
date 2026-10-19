import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { csrfProtection, generateCsrfToken, registerCsrfProtection } from '../csrf';
import { generateAccessToken } from '../../utils/jwt';
import { globalErrorHandler } from '../error-handler';

const sessionToken = (csrf?: string) =>
  generateAccessToken({ userId: 'u1', email: 'a@b.co', role: 'USER', csrf });

describe('CSRF protection (#191)', () => {
  let app: FastifyInstance;
  const csrf = generateCsrfToken();
  const bearer = () => ({ authorization: `Bearer ${sessionToken(csrf)}` });

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(globalErrorHandler);
    registerCsrfProtection(app);
    app.get('/tips', async () => ({ ok: true }));
    app.post('/api/v1/payments/tips', async () => ({ ok: true }));
    app.put('/api/v1/payments/tips/1', async () => ({ ok: true }));
    app.delete('/api/v1/payments/tips/1', async () => ({ ok: true }));
    app.post('/api/v1/auth/register', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('generates unique 256-bit tokens', () => {
    expect(generateCsrfToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });

  it('does not require a token for GET requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/tips', headers: bearer() });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['POST', '/api/v1/payments/tips'],
    ['PUT', '/api/v1/payments/tips/1'],
    ['DELETE', '/api/v1/payments/tips/1'],
  ] as const)('rejects %s %s without a CSRF token with 403', async (method, url) => {
    const res = await app.inject({ method, url, headers: bearer() });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an invalid CSRF token with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/tips',
      headers: { ...bearer(), 'x-csrf-token': generateCsrfToken() },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a token belonging to a different session', async () => {
    const other = generateCsrfToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/tips',
      headers: { authorization: `Bearer ${sessionToken(other)}`, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects sessions whose access token carries no csrf claim', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/tips',
      headers: { authorization: `Bearer ${sessionToken()}`, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a valid token in the header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/tips',
      headers: { ...bearer(), 'x-csrf-token': csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a valid token in the request body', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/payments/tips/1',
      headers: bearer(),
      payload: { _csrf: csrf },
    });
    expect(res.statusCode).toBe(200);
  });

  it('skips public endpoints that have no session (registration)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('skips internal service-to-service calls', async () => {
    const viaHeader = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/tips',
      headers: { 'x-internal-api-key': 'svc-key' },
      payload: {},
    });
    const viaScheme = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/tips',
      headers: { authorization: 'ApiKey svc-key' },
      payload: {},
    });
    expect(viaHeader.statusCode).toBe(200);
    expect(viaScheme.statusCode).toBe(200);
  });

  it('leaves invalid bearer tokens to the auth middleware', async () => {
    await expect(
      csrfProtection(
        { method: 'POST', headers: { authorization: 'Bearer junk' } } as never,
        {} as never
      )
    ).resolves.toBeUndefined();
  });
});
