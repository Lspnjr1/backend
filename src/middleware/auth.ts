import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../utils/jwt';
import { UnauthorizedError } from '../utils/errors';
import { isTokenBlacklisted, isUserAuthVersionCurrent } from '../utils/token-blacklist';
import { setRequestContextUserId } from '../lib/requestContext';
import { registerAuthGuard } from './auth-guards';
import { verifyApiKey } from '../domains/developers/api-key-auth';
import { API_KEY_PREFIX } from '../domains/developers/api-key.constants';

declare module 'fastify' {
  interface FastifyInstance {
    user?: { userId: string; email: string; role: string };
  }
  interface FastifyRequest {
    user?: { userId: string; email: string; role: string };
    apiKey?: { apiKeyId: string; permissions: string[] };
  }
}

/**
 * Developer API key fallback (issue #213): a `Bearer` credential that
 * starts with the API key prefix is verified against `ApiKey` instead of
 * being parsed as a JWT. On success, `request.user` is populated with the
 * key owner's identity (role left empty — API keys authenticate, they
 * don't carry a dashboard role) and `request.apiKey` records which key and
 * scopes were used, so a route can enforce a specific permission.
 */
async function tryApiKeyAuth(request: FastifyRequest, token: string): Promise<boolean> {
  if (!token.startsWith(API_KEY_PREFIX)) return false;

  const verification = await verifyApiKey(token, {
    method: request.method,
    path: request.url,
    ip: request.ip,
  });
  if (!verification) {
    throw new UnauthorizedError('Invalid or revoked API key');
  }

  request.user = { userId: verification.userId, email: '', role: '' };
  request.apiKey = { apiKeyId: verification.apiKeyId, permissions: verification.permissions };
  setRequestContextUserId(verification.userId);
  return true;
}

export const authMiddleware = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);

    if (await tryApiKeyAuth(request, token)) {
      return;
    }

    // Check if token is blacklisted
    const isBlacklisted = await isTokenBlacklisted(token);
    if (isBlacklisted) {
      throw new UnauthorizedError('Token has been revoked');
    }

    const payload = verifyToken(token);
    if (!(await isUserAuthVersionCurrent(payload.userId, payload.authVersion ?? 0))) {
      throw new UnauthorizedError('Token has been revoked');
    }
    request.user = payload;
    // So every log line for the rest of this request — including from
    // code that only has access to the module-level `logger`, not
    // `request` — carries userId too (#26).
    setRequestContextUserId(payload.userId);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    throw new UnauthorizedError('Invalid token');
  }
};

registerAuthGuard(authMiddleware);

export const optionalAuthMiddleware = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  try {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // Check if token is blacklisted
      const isBlacklisted = await isTokenBlacklisted(token);
      if (isBlacklisted) {
        return;
      }

      const payload = verifyToken(token);
      if (!(await isUserAuthVersionCurrent(payload.userId, payload.authVersion ?? 0))) {
        return;
      }
      request.user = payload;
      setRequestContextUserId(payload.userId);
    }
  } catch {
    // Silently ignore if token is invalid for optional auth
  }
};
