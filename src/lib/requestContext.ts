/**
 * Request context propagation for centralized logging (#26).
 *
 * 11 files log via the module-level `logger` from `utils/logger.ts`
 * (not Fastify's request-scoped `request.log`), so none of those log
 * lines carried a requestId/userId — impossible to correlate one
 * request's logs across services once centralized. Refactoring every
 * call site to thread `request`/`reply` through would be a large, risky
 * change for a payments backend; AsyncLocalStorage lets any code, at any
 * depth in the call stack, read the current request's context without
 * that refactor. `utils/logger.ts`'s Pino `mixin` reads this on every
 * log call, so every existing `logger.info(...)` call gains requestId
 * (and userId once authenticated) automatically.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'X-Request-ID';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RequestContext {
  requestId: string;
  userId?: string;
  timestamp?: number;
}

export interface TraceContext {
  requestId: string;
  userId?: string;
  timestamp?: number;
}

export interface JobTracePayload {
  requestId: string;
  userId?: string;
  timestamp: number;
  traceContext: TraceContext;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Accept only bounded, header-safe correlation IDs. */
export function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : undefined;
}

/** Preserve a valid upstream ID, otherwise generate a new one. */
export function resolveRequestId(value: unknown, fallback: () => string): string {
  return sanitizeRequestId(value) ?? fallback();
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Read the current correlation ID without requiring a Fastify request. */
export function getRequestId(): string | undefined {
  return getRequestContext()?.requestId;
}

/** Build a safe header object for axios, fetch, or another HTTP client. */
export function requestIdHeaders(requestId: unknown = getRequestId()): Record<string, string> {
  const resolved = sanitizeRequestId(requestId);
  return resolved ? { [REQUEST_ID_HEADER]: resolved } : {};
}

/** Merge the current correlation header into an outbound HTTP options object. */
export function withRequestIdHeaders<T extends { headers?: Record<string, unknown> }>(
  options: T,
  requestId: unknown = getRequestId()
): T {
  const headers = requestIdHeaders(requestId);
  if (Object.keys(headers).length === 0) return options;
  return { ...options, headers: { ...(options.headers ?? {}), ...headers } };
}

/** Add correlation metadata to an outbound webhook/event payload. */
export function withRequestIdPayload<T extends Record<string, unknown>>(
  payload: T,
  requestId: unknown = getRequestId()
): T {
  const resolved = sanitizeRequestId(requestId);
  return resolved ? { ...payload, requestId: resolved } : payload;
}

/** Ensure a response carries the resolved ID, including framework errors. */
export function setRequestIdResponseHeader(
  reply: { header: (name: string, value: string) => unknown },
  requestId: unknown
): void {
  const resolved = sanitizeRequestId(requestId);
  if (resolved) reply.header(REQUEST_ID_HEADER, resolved);
}

/** Called once auth middleware resolves the user, so later log lines in the same request include userId too. */
export function setRequestContextUserId(userId: string): void {
  const context = storage.getStore();
  if (context) {
    context.userId = userId;
  }
}

/** Read the active trace context. */
export function getTraceContext(): TraceContext | undefined {
  const context = storage.getStore();
  if (!context) return undefined;
  return {
    requestId: context.requestId,
    ...(context.userId ? { userId: context.userId } : {}),
    timestamp: context.timestamp ?? Date.now(),
  };
}

/**
 * Enriches any BullMQ job data payload with trace context so downstream workers
 * and event handlers can correlate operations back to the originating request.
 */
export function withJobTracePayload<T extends Record<string, unknown>>(
  payload: T,
  explicitTrace?: Partial<TraceContext>
): T & JobTracePayload {
  const active = getTraceContext();
  const requestId =
    sanitizeRequestId(explicitTrace?.requestId) ?? active?.requestId ?? randomUUID();
  const userId = explicitTrace?.userId ?? active?.userId;
  const timestamp = explicitTrace?.timestamp ?? active?.timestamp ?? Date.now();

  const traceContext: TraceContext = {
    requestId,
    ...(userId ? { userId } : {}),
    timestamp,
  };

  return {
    ...payload,
    requestId,
    ...(userId ? { userId } : {}),
    timestamp,
    traceContext,
  };
}

/**
 * Extracts a TraceContext from a BullMQ Job or generic payload object.
 * Checks nested `traceContext`, root-level fields, and falls back to a generated ID
 * if processing unsourced background/cron jobs.
 */
export function extractJobTrace(job: { data?: unknown; id?: string | number; name?: string }): TraceContext {
  const data = (job && typeof job.data === 'object' && job.data !== null ? job.data : {}) as Record<string, unknown>;
  const nested = (typeof data.traceContext === 'object' && data.traceContext !== null ? data.traceContext : {}) as Record<string, unknown>;

  const rawRequestId = nested.requestId ?? data.requestId;
  const resolvedRequestId =
    sanitizeRequestId(rawRequestId) ?? (job?.id ? `job-${job.name ? `${job.name}-` : ''}${job.id}` : randomUUID());

  const rawUserId = nested.userId ?? data.userId;
  const userId = typeof rawUserId === 'string' && rawUserId.trim() ? rawUserId.trim() : undefined;

  const rawTimestamp = nested.timestamp ?? data.timestamp;
  const timestamp =
    typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp) ? rawTimestamp : Date.now();

  return {
    requestId: resolvedRequestId,
    ...(userId ? { userId } : {}),
    timestamp,
  };
}

/**
 * Runs a function within the execution context derived from a BullMQ job.
 */
export function runWithJobContext<T>(
  job: { data?: unknown; id?: string | number; name?: string },
  fn: () => T
): T {
  const trace = extractJobTrace(job);
  return runWithRequestContext(trace, fn);
}

/**
 * Worker processor middleware.
 * Wraps any BullMQ worker processing function so it automatically executes inside
 * the restored request context. Worker logs, database transactions, and chained jobs
 * inherit the originating requestId and userId.
 */
export function withWorkerContext<TJob extends { data?: unknown; id?: string | number; name?: string }, TResult>(
  processor: (job: TJob) => Promise<TResult>
): (job: TJob) => Promise<TResult> {
  return (job: TJob) => runWithJobContext(job, () => processor(job));
}

