import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerChargeRoutes } from '../charge.routes';
import { FakePrisma } from './fake-prisma';
import { FakePaymentProvider } from '../../../lib/payments/provider';
import { generateAccessToken } from '../../../utils/jwt';
import { AppError } from '../../../utils/errors';
import { applyJsonSerializer } from '../../../config/serialization';
import { initTokenBlacklist } from '../../../utils/token-blacklist';

function tokenFor(userId: string): string {
  return generateAccessToken({ userId, email: `${userId}@test.com`, role: 'fan' });
}

function buildApp(prisma: FakePrisma, provider: FakePaymentProvider): FastifyInstance {
  const app = Fastify({ logger: false });
  applyJsonSerializer(app);
  // Wire up the fake prisma so auth middleware can verify token validity
  initTokenBlacklist(prisma as never);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ code: error.code, message: error.message });
      return;
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ message: error.message });
  });
  registerChargeRoutes(app, prisma as never, provider);
  return app;
}

describe('payment routes', () => {
  let app: FastifyInstance;
  let prisma: FakePrisma;
  let provider: FakePaymentProvider;

  beforeEach(async () => {
    prisma = new FakePrisma();
    provider = new FakePaymentProvider({ status: 'succeeded' });
    app = buildApp(prisma, provider);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires authentication to create a payment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      payload: { amount: 10, method: 'card' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a payment for an authenticated user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { authorization: `Bearer ${tokenFor('user-1')}`, 'idempotency-key': 'c0ffee00-0000-4000-a000-000000000001' },
      payload: { amount: 10, currency: 'USD', method: 'card' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('succeeded');
    expect(body.data.clientSecret).toBeDefined();
  });

  it('validates the payment body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { authorization: `Bearer ${tokenFor('user-1')}` },
      payload: { amount: -5, method: 'card' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('lists the caller payments', async () => {
    const auth = { authorization: `Bearer ${tokenFor('user-1')}` };
    await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { ...auth },
      payload: { amount: 10, method: 'card' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/payments', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.total).toBe(1);
  });

  it('returns a single payment and forbids other users', async () => {
    const auth = { authorization: `Bearer ${tokenFor('user-1')}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: auth,
      payload: { amount: 10, method: 'card' },
    });
    const id = created.json().data.id;

    const own = await app.inject({ method: 'GET', url: `/api/v1/payments/${id}`, headers: auth });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${id}`,
      headers: { authorization: `Bearer ${tokenFor('user-2')}` },
    });
    expect(other.statusCode).toBe(403);
  });

  it('refunds a payment', async () => {
    const auth = { authorization: `Bearer ${tokenFor('user-1')}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: auth,
      payload: { amount: 40, method: 'card' },
    });
    const id = created.json().data.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${id}/refund`,
      headers: { ...auth, 'idempotency-key': 'c0ffee00-0000-4000-a000-000000000002' },
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.amount).toBe(40);
  });

  it('accepts a correctly signed webhook', async () => {
    const payload = JSON.stringify({
      id: 'evt_route_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_unknown' } },
    });
    const signature = provider.sign(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/fake',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('rejects an unsigned webhook', async () => {
    const payload = JSON.stringify({ id: 'evt_route_2', type: 'payment_intent.succeeded', data: { object: { id: 'x' } } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/fake',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bogus' },
      payload,
    });

    expect(res.statusCode).toBe(401);
  });

  describe('idempotency key validation', () => {
    const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
    const VALID_UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const authHeaders = () => ({ authorization: `Bearer ${tokenFor('user-1')}` });

    it('rejects a non-UUID Idempotency-Key header → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: { ...authHeaders(), 'idempotency-key': 'not-a-uuid' },
        payload: { amount: 10, currency: 'USD', method: 'card' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects an empty string Idempotency-Key header → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: { ...authHeaders(), 'idempotency-key': '' },
        payload: { amount: 10, currency: 'USD', method: 'card' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('auto-generates an idempotency key when none is provided → 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: authHeaders(),
        payload: { amount: 10, currency: 'USD', method: 'card' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.id).toBeDefined();
    });

    it('rejects a non-UUID idempotency key in body → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: authHeaders(),
        payload: { amount: 10, currency: 'USD', method: 'card', idempotencyKey: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty string idempotency key in body → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: authHeaders(),
        payload: { amount: 10, currency: 'USD', method: 'card', idempotencyKey: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns the same result for a duplicate key with same amount/creator → 201, same id', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: { ...authHeaders(), 'idempotency-key': VALID_UUID },
        payload: { amount: 20, currency: 'USD', method: 'card' },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: { ...authHeaders(), 'idempotency-key': VALID_UUID },
        payload: { amount: 20, currency: 'USD', method: 'card' },
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(first.json().data.id);
      expect(prisma.payments).toHaveLength(1);
    });

    it('returns 409 DUPLICATE_PAYMENT for duplicate key with different amount', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: { ...authHeaders(), 'idempotency-key': VALID_UUID_2 },
        payload: { amount: 10, currency: 'USD', method: 'card' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: { ...authHeaders(), 'idempotency-key': VALID_UUID_2 },
        payload: { amount: 99, currency: 'USD', method: 'card' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_PAYMENT');
    });

    it('returns 409 DUPLICATE_PAYMENT for duplicate key with different creatorId', async () => {
      const KEY = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

      await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: { ...authHeaders(), 'idempotency-key': KEY },
        payload: { amount: 10, currency: 'USD', method: 'card', creatorId: 'c-1' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: { ...authHeaders(), 'idempotency-key': KEY },
        payload: { amount: 10, currency: 'USD', method: 'card', creatorId: 'c-2' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_PAYMENT');
    });
  });
});
