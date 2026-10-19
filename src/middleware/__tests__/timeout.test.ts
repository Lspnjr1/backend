import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerRequestTimeout, resetRequestTimeoutHook } from '../timeout';

vi.mock('../../config', () => ({
  config: { REQUEST_TIMEOUT_MS: 100, AUTH_REQUEST_TIMEOUT_MS: 20 },
}));

describe('registerRequestTimeout', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestTimeoutHook();
    app = Fastify();
    registerRequestTimeout(app);

    app.get('/api/v1/things/:id', async () => ({ ok: true }));
    app.get('/api/v1/auth/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    });
    app.get('/api/v1/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true };
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lets a fast request through unaffected', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/things/abc' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('returns 504 when a request exceeds the default timeout', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/slow' });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'GATEWAY_TIMEOUT' },
    });
  });

  it('returns 504 for an auth route exceeding the tighter auth timeout, even though it would fit the default budget', async () => {
    // 50ms exceeds the mocked 20ms auth budget but is well under the 100ms default.
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/slow' });
    expect(response.statusCode).toBe(504);
  });

  it('only installs one pair of hooks, even if registration runs twice', async () => {
    registerRequestTimeout(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/things/abc' });
    expect(response.statusCode).toBe(200);
  });

  it('clears the timer on a normal response, so it never fires after the fact', async () => {
    const clearTimeoutFn = vi.fn(clearTimeout);
    resetRequestTimeoutHook();
    const freshApp = Fastify();
    registerRequestTimeout(freshApp, { clearTimeoutFn });
    freshApp.get('/x', async () => ({ ok: true }));
    await freshApp.ready();

    await freshApp.inject({ method: 'GET', url: '/x' });
    expect(clearTimeoutFn).toHaveBeenCalledTimes(1);

    await freshApp.close();
  });
});
