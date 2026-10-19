import { PrismaClient } from '@prisma/client';
import { ApiKeyService, ApiKeyVerification } from './api-key.service';

/**
 * Module-level singleton following the same pattern as
 * `initTokenBlacklist`/`src/utils/token-blacklist.ts`: `authMiddleware` has
 * no `prisma` parameter of its own, so the service it needs for the API key
 * fallback is initialized once at bootstrap and read from module state.
 */
let service: ApiKeyService | undefined;

export const initApiKeyAuth = (prismaClient: PrismaClient): void => {
  service = new ApiKeyService(prismaClient);
};

export const verifyApiKey = (
  rawKey: string,
  context: { method?: string; path?: string; ip?: string } = {}
): Promise<ApiKeyVerification | null> => {
  if (!service) return Promise.resolve(null);
  return service.verifyKey(rawKey, context);
};
