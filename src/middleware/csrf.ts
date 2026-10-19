/**
 * CSRF protection (#191) using the synchronizer token pattern.
 *
 * A random CSRF token is minted whenever a session's access token is issued
 * (login and token refresh, so it is rotated on every login) and embedded in
 * the signed access token as the `csrf` claim. The same value is returned to
 * the client, which must echo it back in the `X-CSRF-Token` header (or a
 * `_csrf` body field) on every state-changing request. The echoed value is
 * compared in constant time with the one bound to the session's access token.
 *
 * Not enforced for:
 *  - safe methods (GET/HEAD/OPTIONS)
 *  - requests without a user bearer token: public endpoints (registration,
 *    login, password reset, signature-verified webhooks) have no session to
 *    protect, and protected endpoints reject them with 401 in authMiddleware
 *  - internal service-to-service calls (ApiKey credentials)
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from '../utils/jwt';
import { ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';

export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_BODY_FIELD = '_csrf';

const PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SERVICE_HEADER = 'x-internal-api-key';

/** Mint a fresh, unguessable session-bound CSRF token. */
export const generateCsrfToken = (): string => randomBytes(32).toString('hex');

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isServiceCall(request: FastifyRequest): boolean {
  if (request.headers[SERVICE_HEADER] !== undefined) return true;
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && /^ApiKey\s/i.test(authorization.trim());
}

function sessionCsrfToken(request: FastifyRequest): string | undefined | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  try {
    return verifyToken(authorization.substring(7)).csrf;
  } catch {
    // Invalid/expired token: authMiddleware produces the 401.
    return null;
  }
}

function submittedCsrfToken(request: FastifyRequest): string | undefined {
  const header = request.headers[CSRF_HEADER];
  if (typeof header === 'string' && header) return header;
  const body = request.body;
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>)[CSRF_BODY_FIELD];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export const csrfProtection = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  if (!PROTECTED_METHODS.has(request.method)) return;
  if (isServiceCall(request)) return;

  const expected = sessionCsrfToken(request);
  if (expected === null) return;

  const submitted = submittedCsrfToken(request);
  if (!expected || !submitted || !safeEqual(submitted, expected)) {
    logger.warn(
      { event: 'csrf.rejected', requestId: request.id, method: request.method, url: request.url },
      'CSRF token missing or invalid'
    );
    throw new ForbiddenError('Invalid or missing CSRF token');
  }
};

/**
 * Register on the root instance before any route so the hook applies to all
 * of them. It runs as a preHandler so the body has been parsed (`_csrf`).
 */
export function registerCsrfProtection(app: FastifyInstance): void {
  app.addHook('preHandler', csrfProtection);
}
