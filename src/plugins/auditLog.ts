/**
 * Automatic audit logging for state-changing requests (issue #215).
 *
 * `AuditService` (src/services/audit.service.ts) and the `AuditLog` model
 * already existed, written to only by a handful of call sites
 * (`webhook.service.ts`'s secret rotation, `dispute.service.ts`'s
 * compliance actions) that each know a specific, semantically rich
 * `action`/`resource`/`changes` to record. This hook is deliberately
 * coarser: it cannot know what a route's body diff means, only that a
 * non-GET/HEAD request completed. It records `METHOD /route/pattern` as
 * the action and the route's first path segment as the resource, so every
 * state-changing endpoint gets *some* audit coverage even before (or
 * instead of) a bespoke call site is added for it — following the same
 * `onResponse` hook pattern as `plugins/requestMetrics.ts`, which is the
 * only place a request's final outcome (status code) is known.
 *
 * Read-only requests (GET/HEAD/OPTIONS) are not logged: they do not change
 * state, and logging every page view both floods the audit log and
 * defeats using it to investigate what changed.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuditService } from '../services/audit.service';
import { getRequestId } from '../lib/requestContext';

/** Routes excluded from audit logging: not state changes, or would recurse. */
const EXCLUDED_ROUTES = [
  '/health',
  '/metrics',
  '/api/v1/users/me/activity',
  '/api/v1/admin/audit-log',
];

/** HTTP methods considered state-changing. */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function resolveAuditRoutePattern(request: FastifyRequest): string {
  const route = (request as { routeOptions?: { url?: string } }).routeOptions?.url;
  if (route) return route;
  return request.url.split('?')[0];
}

function resolveResource(route: string): string {
  // "/api/v1/transactions/tip" -> "transactions"; "/api/v1/webhooks/:id" -> "webhooks".
  const segments = route.split('/').filter(Boolean);
  const apiIndex = segments.indexOf('v1');
  const resourceSegment = apiIndex >= 0 ? segments[apiIndex + 1] : segments[segments.length - 1];
  return resourceSegment ?? 'unknown';
}

function shouldAudit(request: FastifyRequest, route: string): boolean {
  if (!STATE_CHANGING_METHODS.has(request.method)) return false;
  return !EXCLUDED_ROUTES.some((excluded) => route === excluded || route.startsWith(excluded));
}

export interface RegisterAuditLogOptions {
  auditService: AuditService;
}

/**
 * Registers the audit logging hook. Idempotent for the same reason as
 * `registerRequestMetrics`: the entrypoint's route-registration functions
 * can run more than once in some bootstrap paths, and a second hook would
 * double-write every audit entry.
 */
let hookRegistered = false;

export function registerAuditLog(app: FastifyInstance, options: RegisterAuditLogOptions): void {
  if (hookRegistered) return;
  hookRegistered = true;

  const { auditService } = options;

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = resolveAuditRoutePattern(request);
    if (!shouldAudit(request, route)) return;
    // Only a request that actually changed something is worth recording;
    // a failed write (4xx/5xx) did not change state.
    if (reply.statusCode >= 400) return;

    try {
      await auditService.record({
        userId: request.user?.userId,
        action: `${request.method} ${route}`,
        resource: resolveResource(route),
        ipAddress: request.ip,
        requestId: getRequestId(),
      });
    } catch (error) {
      // Audit logging must never fail the request it is observing.
      request.log.error({ err: error, route }, 'Failed to write audit log entry');
    }
  });
}

/** Test seam: allow the hook to be registered again in a fresh app. */
export function resetAuditLogHook(): void {
  hookRegistered = false;
}
