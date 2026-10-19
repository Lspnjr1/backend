import { describe, it, expect } from 'vitest';
import {
  runWithRequestContext,
  getRequestContext,
  getRequestId,
  getTraceContext,
  requestIdHeaders,
  resolveRequestId,
  sanitizeRequestId,
  setRequestContextUserId,
  withJobTracePayload,
  withRequestIdHeaders,
  withRequestIdPayload,
  withWorkerContext,
  extractJobTrace,
} from '../requestContext';

describe('requestContext (#26)', () => {
  it('returns undefined outside of any established context', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('exposes the context established by runWithRequestContext', () => {
    runWithRequestContext({ requestId: 'req-1' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'req-1' });
    });
  });

  it('setRequestContextUserId mutates the currently active context', () => {
    runWithRequestContext({ requestId: 'req-2' }, () => {
      setRequestContextUserId('user-42');
      expect(getRequestContext()).toEqual({ requestId: 'req-2', userId: 'user-42' });
    });
  });

  it('isolates concurrent contexts from each other', async () => {
    const results: Array<string | undefined> = [];

    await Promise.all([
      runWithRequestContext({ requestId: 'req-a' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getRequestContext()?.requestId);
      }),
      runWithRequestContext({ requestId: 'req-b' }, async () => {
        results.push(getRequestContext()?.requestId);
      }),
    ]);

    expect(results).toContain('req-a');
    expect(results).toContain('req-b');
  });

  it('does not leak a context set inside one run() call into a sibling call', () => {
    runWithRequestContext({ requestId: 'req-3' }, () => {
      setRequestContextUserId('user-3');
    });

    runWithRequestContext({ requestId: 'req-4' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'req-4' });
    });
  });

  it('accepts only bounded, header-safe incoming IDs', () => {
    expect(sanitizeRequestId(' upstream.req-1 ')).toBe('upstream.req-1');
    expect(sanitizeRequestId('bad id')).toBeUndefined();
    expect(sanitizeRequestId('a\r\nb')).toBeUndefined();
    expect(sanitizeRequestId('a'.repeat(129))).toBeUndefined();
    expect(resolveRequestId('bad id', () => 'generated')).toBe('generated');
  });

  it('forwards the active ID to HTTP headers and webhook payloads', () => {
    runWithRequestContext({ requestId: 'req-forward-1' }, () => {
      expect(getRequestId()).toBe('req-forward-1');
      expect(requestIdHeaders()).toEqual({ 'X-Request-ID': 'req-forward-1' });
      expect(withRequestIdHeaders({ headers: { Authorization: 'Bearer token' } })).toEqual({
        headers: { Authorization: 'Bearer token', 'X-Request-ID': 'req-forward-1' },
      });
      expect(withRequestIdPayload({ event: 'tip.created' })).toEqual({
        event: 'tip.created',
        requestId: 'req-forward-1',
      });
    });
  });

  describe('distributed tracing helpers (#184)', () => {
    it('returns trace context matching active request context', () => {
      const now = Date.now();
      runWithRequestContext({ requestId: 'req-trace-1', userId: 'user-100', timestamp: now }, () => {
        expect(getTraceContext()).toEqual({
          requestId: 'req-trace-1',
          userId: 'user-100',
          timestamp: now,
        });
      });
    });

    it('withJobTracePayload injects trace context from active request', () => {
      runWithRequestContext({ requestId: 'req-job-1', userId: 'user-50' }, () => {
        const enriched = withJobTracePayload({ tipId: 'tip-99' });
        expect(enriched.tipId).toBe('tip-99');
        expect(enriched.requestId).toBe('req-job-1');
        expect(enriched.userId).toBe('user-50');
        expect(typeof enriched.timestamp).toBe('number');
        expect(enriched.traceContext).toEqual({
          requestId: 'req-job-1',
          userId: 'user-50',
          timestamp: enriched.timestamp,
        });
      });
    });

    it('withJobTracePayload allows explicit override of trace parameters', () => {
      const payload = withJobTracePayload(
        { data: 'test' },
        { requestId: 'req-override', userId: 'user-custom', timestamp: 12345 }
      );
      expect(payload.requestId).toBe('req-override');
      expect(payload.userId).toBe('user-custom');
      expect(payload.timestamp).toBe(12345);
      expect(payload.traceContext).toEqual({
        requestId: 'req-override',
        userId: 'user-custom',
        timestamp: 12345,
      });
    });

    it('extractJobTrace correctly parses nested and flat payloads', () => {
      const jobWithNested = {
        id: '123',
        name: 'confirm-stellar',
        data: {
          traceContext: { requestId: 'req-nested-1', userId: 'u-1', timestamp: 555 },
        },
      };
      expect(extractJobTrace(jobWithNested)).toEqual({
        requestId: 'req-nested-1',
        userId: 'u-1',
        timestamp: 555,
      });

      const jobWithFlat = {
        id: '456',
        name: 'dispatch-webhook',
        data: {
          requestId: 'req-flat-1',
          userId: 'u-2',
          timestamp: 777,
        },
      };
      expect(extractJobTrace(jobWithFlat)).toEqual({
        requestId: 'req-flat-1',
        userId: 'u-2',
        timestamp: 777,
      });

      const unsourcedJob = {
        id: '789',
        name: 'analytics.aggregate',
        data: {},
      };
      const fallback = extractJobTrace(unsourcedJob);
      expect(fallback.requestId).toBe('job-analytics.aggregate-789');
      expect(fallback.userId).toBeUndefined();
      expect(typeof fallback.timestamp).toBe('number');
    });

    it('withWorkerContext restores context within worker execution', async () => {
      let observedRequestId: string | undefined;
      let observedUserId: string | undefined;

      const rawProcessor = async (job: { data: Record<string, unknown>; id: string; name: string }) => {
        observedRequestId = getRequestId();
        observedUserId = getRequestContext()?.userId;
        return { success: true };
      };

      const wrappedProcessor = withWorkerContext(rawProcessor);

      const job = {
        id: 'job-1',
        name: 'confirm-stellar',
        data: {
          requestId: 'req-worker-trace',
          userId: 'user-origin',
        },
      };

      const result = await wrappedProcessor(job);
      expect(result).toEqual({ success: true });
      expect(observedRequestId).toBe('req-worker-trace');
      expect(observedUserId).toBe('user-origin');

      // Verify context does not leak outside worker execution
      expect(getRequestContext()).toBeUndefined();
    });
  });
});

