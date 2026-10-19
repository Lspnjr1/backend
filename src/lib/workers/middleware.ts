/**
 * Worker context middleware for distributed tracing (#184).
 *
 * Restores the originating request context (requestId, userId, timestamp)
 * before any worker processor runs, ensuring all logger calls, database queries,
 * and downstream jobs inherit the originating trace.
 */

export {
  withWorkerContext,
  runWithJobContext,
  extractJobTrace,
  withJobTracePayload,
  getTraceContext,
  getRequestId,
  getRequestContext,
  type TraceContext,
  type JobTracePayload,
} from '../requestContext';
