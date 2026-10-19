import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { AuditService } from '../../services/audit.service';
import { registerAuditLog, resetAuditLogHook, resolveAuditRoutePattern } from '../auditLog';

function makeAuditService() {
  const recordMock = vi.fn().mockResolvedValue({});
  const auditService = { record: recordMock } as unknown as AuditService;
  return { auditService, recordMock };
}

describe('registerAuditLog', () => {
  let app: FastifyInstance;
  let recordMock: ReturnType<typeof makeAuditService>['recordMock'];

  beforeEach(async () => {
    resetAuditLogHook();
    const service = makeAuditService();
    recordMock = service.recordMock;
    app = Fastify();
    registerAuditLog(app, { auditService: service.auditService });

    app.get('/api/v1/things/:id', async () => ({ ok: true }));
    app.post('/api/v1/things', async (_request, reply) => {
      reply.code(201).send({ ok: true });
    });
    app.patch('/api/v1/things/:id', async () => ({ ok: true }));
    app.delete('/api/v1/things/:id', async (_request, reply) => {
      reply.code(204).send();
    });
    app.post('/api/v1/boom', async (_request, reply) => {
      reply.code(400).send({ error: 'bad' });
    });
    app.get('/health', async () => ({ status: 'ok' }));
    app.post('/metrics', async () => ({ ok: true }));
    app.post(
      '/api/v1/authed-things',
      {
        preHandler: async (request) => {
          (request as any).user = { userId: 'user-1', email: 'u@example.com', role: 'fan' };
        },
      },
      async () => ({ ok: true })
    );

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('logs a POST request as a state change', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/things' });

    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'POST /api/v1/things',
        resource: 'things',
      })
    );
  });

  it('logs a PATCH request', async () => {
    await app.inject({ method: 'PATCH', url: '/api/v1/things/abc' });

    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PATCH /api/v1/things/:id' })
    );
  });

  it('logs a DELETE request', async () => {
    await app.inject({ method: 'DELETE', url: '/api/v1/things/abc' });

    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DELETE /api/v1/things/:id' })
    );
  });

  it('does not log a GET request (read-only, not a state change)', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/things/abc' });

    expect(recordMock).not.toHaveBeenCalled();
  });

  it('does not log a request that failed (4xx/5xx did not change state)', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/boom' });

    expect(recordMock).not.toHaveBeenCalled();
  });

  it('excludes health and metrics endpoints', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'POST', url: '/metrics' });

    expect(recordMock).not.toHaveBeenCalled();
  });

  it('includes the authenticated userId when present', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/authed-things' });

    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('a failure to write the audit entry does not fail the request', async () => {
    recordMock.mockRejectedValueOnce(new Error('db unavailable'));

    const response = await app.inject({ method: 'POST', url: '/api/v1/things' });

    expect(response.statusCode).toBe(201);
  });

  it('only installs one hook, even if registration runs twice', async () => {
    const service = makeAuditService();
    registerAuditLog(app, { auditService: service.auditService });

    await app.inject({ method: 'POST', url: '/api/v1/things' });

    // Only the first-registered service's hook fires.
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(service.recordMock).not.toHaveBeenCalled();
  });

  it('resolveAuditRoutePattern falls back to the path without query', async () => {
    // Not a registered route, so Fastify never resolves a route pattern.
    const fakeRequest = { url: '/unknown/path?x=1' } as any;
    expect(resolveAuditRoutePattern(fakeRequest)).toBe('/unknown/path');
  });
});
