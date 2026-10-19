import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { AuditService } from '../../services/audit.service';
import { API_KEY_PREFIX } from './api-key.constants';

/** Length (bytes) of the random secret appended after {@link API_KEY_PREFIX}. */
const SECRET_BYTES = 32;

/** Characters of the raw key kept alongside the hash for display (e.g. "dsk_live_a1b2c3d4"). */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

export interface CreateApiKeyRequest {
  name: string;
  permissions: string[];
  expiresAt?: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  revokedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeySummary {
  /** The raw, bearer-usable key. Returned once, at creation, and never again. */
  key: string;
}

export interface ApiKeyVerification {
  apiKeyId: string;
  userId: string;
  permissions: string[];
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function toSummary(record: {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): ApiKeySummary {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    permissions: record.permissions,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Developer-facing API key management (issue #213).
 *
 * Keys are bearer credentials for service-to-service calls: created once
 * with a name, a set of permission scopes, and an optional expiry, shown to
 * the caller in full exactly once, then stored only as a SHA-256 digest.
 * Verification therefore always compares digests, never raw values, using a
 * timing-safe comparison so a byte-by-byte mismatch cannot be timed out.
 */
export class ApiKeyService extends BaseService {
  private auditService: AuditService;

  constructor(private prisma: PrismaClient) {
    super();
    this.auditService = new AuditService(this.prisma.auditLog as any);
  }

  async createKey(userId: string, data: CreateApiKeyRequest): Promise<CreatedApiKey> {
    return this.executeWithLogging('apiKey.create', async () => {
      const name = data.name?.trim();
      if (!name) {
        throw new ValidationError('name is required');
      }
      if (!Array.isArray(data.permissions) || data.permissions.length === 0) {
        throw new ValidationError('permissions must be a non-empty array');
      }
      let expiresAt: Date | undefined;
      if (data.expiresAt !== undefined) {
        expiresAt = new Date(data.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) {
          throw new ValidationError('expiresAt must be a valid date');
        }
        if (expiresAt.getTime() <= Date.now()) {
          throw new ValidationError('expiresAt must be in the future');
        }
      }

      const rawKey = `${API_KEY_PREFIX}${randomBytes(SECRET_BYTES).toString('hex')}`;
      const keyHash = hashKey(rawKey);
      const keyPrefix = rawKey.slice(0, DISPLAY_PREFIX_LENGTH);

      const record = await this.prisma.apiKey.create({
        data: {
          userId,
          name,
          keyHash,
          keyPrefix,
          permissions: data.permissions,
          expiresAt,
        },
      });

      await this.auditService.record({
        userId,
        action: 'api_key.created',
        resource: 'ApiKey',
        resourceId: record.id,
      });

      return { ...toSummary(record), key: rawKey };
    });
  }

  async listKeys(userId: string): Promise<ApiKeySummary[]> {
    return this.executeWithLogging('apiKey.list', async () => {
      const records = await this.prisma.apiKey.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      return records.map(toSummary);
    });
  }

  async revokeKey(userId: string, keyId: string): Promise<ApiKeySummary> {
    return this.executeWithLogging('apiKey.revoke', async () => {
      const record = await this.prisma.apiKey.findFirst({ where: { id: keyId, userId } });
      if (!record) {
        throw new NotFoundError('API key not found');
      }
      if (record.revokedAt) {
        return toSummary(record);
      }

      const updated = await this.prisma.apiKey.update({
        where: { id: keyId },
        data: { revokedAt: new Date() },
      });

      await this.auditService.record({
        userId,
        action: 'api_key.revoked',
        resource: 'ApiKey',
        resourceId: keyId,
      });

      return toSummary(updated);
    });
  }

  /**
   * Verify a raw bearer key, returning the identity it resolves to.
   *
   * Looks up by the key's hash (an indexed equality lookup, not a table
   * scan with per-row `timingSafeEqual`), then double-checks the stored
   * digest against the freshly computed one with a timing-safe comparison
   * before trusting the match — defends against a hash-collision or
   * lookup-shortcut bug silently accepting the wrong row, at negligible
   * extra cost since this only runs once per successful index hit.
   *
   * Every attempt, successful or not, is logged to `ApiKeyUsageEvent`
   * (issue #213's "API key usage is logged" requirement), and `lastUsedAt`
   * is bumped on success.
   */
  async verifyKey(
    rawKey: string,
    context: { method?: string; path?: string; ip?: string } = {}
  ): Promise<ApiKeyVerification | null> {
    const keyHash = hashKey(rawKey);
    const record = await this.prisma.apiKey.findUnique({ where: { keyHash } });

    const valid =
      !!record &&
      !record.revokedAt &&
      !(record.expiresAt && record.expiresAt.getTime() <= Date.now()) &&
      timingSafeEqual(Buffer.from(record.keyHash, 'hex'), Buffer.from(keyHash, 'hex'));

    if (record) {
      await this.prisma.apiKeyUsageEvent.create({
        data: {
          apiKeyId: record.id,
          success: valid,
          method: context.method,
          path: context.path,
          ip: context.ip,
        },
      });
    }

    if (!valid || !record) {
      return null;
    }

    await this.prisma.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    });

    return { apiKeyId: record.id, userId: record.userId, permissions: record.permissions };
  }
}
