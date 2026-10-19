/**
 * Request timeout middleware (issue #206).
 *
 * A long-running query (payment listing, search) can run past a sane
 * budget with no explicit handling, tying up the connection and leaving
 * the client waiting indefinitely. Node has no way to forcibly cancel an
 * in-flight Prisma query from a Fastify hook — Prisma 5's `$transaction`/
 * query methods do not accept an `AbortSignal` here — so this middleware
 * races the route handler against a timer instead: if the handler has not
 * responded by the deadline, the client gets a 504 immediately, while the
 * handler's own promise is left to settle in the background. The *query*
 * itself is still bounded server-side by Postgres's own `statement_timeout`
 * (src/db/connection.ts, `DB_STATEMENT_TIMEOUT_MS`), which is what actually
 * terminates a runaway query rather than just stopping the client from
 * waiting on it.
 *
 * Implemented as a `preHandler`/`onSend` pair rather than Fastify's
 * built-in `connectionTimeout` (a raw socket idle timeout, not tied to a
 * single request's processing budget) or `onRequest` (too early — the
 * route is not yet resolved, so an auth-vs-default budget cannot be
 * chosen).
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';

const AUTH_ROUTE_PREFIX = '/api/v1/auth/';

/** Per-request bookkeeping, keyed by the request itself via a WeakMap. */
interface TimeoutState {
  timer: ReturnType<typeof setTimeout>;
  timedOut: boolean;
}

const states = new WeakMap<FastifyRequest, TimeoutState>();

function timeoutBudgetMs(route: string): number {
  return route.startsWith(AUTH_ROUTE_PREFIX)
    ? config.AUTH_REQUEST_TIMEOUT_MS
    : config.REQUEST_TIMEOUT_MS;
}

export interface RegisterRequestTimeoutOptions {
  /** Injected for tests; defaults to the real timer functions. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

let hookRegistered = false;

/**
 * Registers the timeout hooks. Idempotent for the same reason as
 * `registerRequestMetrics`/`registerAuditLog`: a second registration would
 * install a second competing timer per request.
 */
export function registerRequestTimeout(
  app: FastifyInstance,
  options: RegisterRequestTimeoutOptions = {}
): void {
  if (hookRegistered) return;
  hookRegistered = true;

  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.url.split('?')[0];
    const budgetMs = timeoutBudgetMs(route);

    const state: TimeoutState = {
      timedOut: false,
      timer: setTimeoutFn(() => {
        state.timedOut = true;
        if (!reply.sent) {
          reply.code(504).send({
            success: false,
            error: {
              code: 'GATEWAY_TIMEOUT',
              message: `Request exceeded its ${budgetMs}ms timeout`,
            },
            timestamp: new Date().toISOString(),
          });
        }
      }, budgetMs),
    };
    states.set(request, state);
  });

  app.addHook('onResponse', async (request: FastifyRequest) => {
    const state = states.get(request);
    if (state) {
      clearTimeoutFn(state.timer);
      states.delete(request);
    }
  });
}

/** Test seam: allow the hooks to be registered again in a fresh app. */
export function resetRequestTimeoutHook(): void {
  hookRegistered = false;
}
