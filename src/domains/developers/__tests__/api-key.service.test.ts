import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ApiKeyService } from '../api-key.service';
import { API_KEY_PREFIX } from '../api-key.constants';
import { ValidationError, NotFoundError } from '../../../utils/errors';

let prisma: PrismaClient;
let service: ApiKeyService;
const createdUserIds: string[] = [];
let testUserId: string;
const isDbAvailable = Boolean(process.env.DATABASE_URL);
let dbReachable = false;

describe.skipIf(!isDbAvailable)('ApiKeyService (issue #213)', () => {
  beforeAll(async () => {
    if (!isDbAvailable) {
      console.warn('DATABASE_URL not set, skipping ApiKeyService tests');
      return;
    }
    try {
      prisma = new PrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      dbReachable = true;
      service = new ApiKeyService(prisma);
    } catch {
      console.warn('Database connection failed, skipping ApiKeyService tests');
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    if (!dbReachable) {
      await prisma.$disconnect().catch(() => undefined);
      return;
    }
    try {
      await prisma.apiKeyUsageEvent.deleteMany({
        where: { apiKey: { userId: { in: createdUserIds } } },
      });
      await prisma.apiKey.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.$disconnect();
    } catch {
      // ignore cleanup errors on disconnected DB
    }
  });

  beforeEach(async (ctx) => {
    if (!dbReachable || !prisma) {
      ctx.skip();
      return;
    }
    const user = await prisma.user.create({
      data: {
        email: `apikey-${randomUUID()}@test.com`,
        password: 'hashed-password',
        name: 'Test Developer',
        role: 'fan',
      },
    });
    testUserId = user.id;
    createdUserIds.push(user.id);
  });

  it('creates a key, returning the raw value exactly once', async () => {
    const created = await service.createKey(testUserId, {
      name: 'CI integration',
      permissions: ['payments:read'],
    });

    expect(created.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(created.keyPrefix).toBe(created.key.slice(0, created.keyPrefix.length));
    expect(created.permissions).toEqual(['payments:read']);
    expect(created.revokedAt).toBeNull();

    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.keyHash).not.toBe(created.key);
  });

  it('rejects an empty name', async () => {
    await expect(
      service.createKey(testUserId, { name: '  ', permissions: ['payments:read'] })
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an empty permissions array', async () => {
    await expect(
      service.createKey(testUserId, { name: 'No scopes', permissions: [] })
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an expiresAt in the past', async () => {
    await expect(
      service.createKey(testUserId, {
        name: 'Already expired',
        permissions: ['payments:read'],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
    ).rejects.toThrow(ValidationError);
  });

  it('verifies a freshly created key and resolves the owning user', async () => {
    const created = await service.createKey(testUserId, {
      name: 'Verify path',
      permissions: ['webhooks:write'],
    });

    const verification = await service.verifyKey(created.key);
    expect(verification).toEqual({
      apiKeyId: created.id,
      userId: testUserId,
      permissions: ['webhooks:write'],
    });
  });

  it('rejects an unknown key', async () => {
    const verification = await service.verifyKey(`${API_KEY_PREFIX}${'0'.repeat(64)}`);
    expect(verification).toBeNull();
  });

  it('rejects a revoked key', async () => {
    const created = await service.createKey(testUserId, {
      name: 'Revoke me',
      permissions: ['payments:read'],
    });
    await service.revokeKey(testUserId, created.id);

    const verification = await service.verifyKey(created.key);
    expect(verification).toBeNull();
  });

  it('rejects an expired key', async () => {
    const created = await service.createKey(testUserId, {
      name: 'Expires soon',
      permissions: ['payments:read'],
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    await prisma.apiKey.update({
      where: { id: created.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const verification = await service.verifyKey(created.key);
    expect(verification).toBeNull();
  });

  it('logs every verification attempt, successful or not', async () => {
    const created = await service.createKey(testUserId, {
      name: 'Usage logging',
      permissions: ['payments:read'],
    });

    await service.verifyKey(created.key, { method: 'GET', path: '/api/payments', ip: '127.0.0.1' });
    await service.revokeKey(testUserId, created.id);
    await service.verifyKey(created.key, { method: 'GET', path: '/api/payments', ip: '127.0.0.1' });

    const events = await prisma.apiKeyUsageEvent.findMany({
      where: { apiKeyId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[0].success).toBe(true);
    expect(events[1].success).toBe(false);
    expect(events[0].method).toBe('GET');
    expect(events[0].path).toBe('/api/payments');
  });

  it('bumps lastUsedAt only on a successful verification', async () => {
    const created = await service.createKey(testUserId, {
      name: 'Last used tracking',
      permissions: ['payments:read'],
    });
    expect(created.lastUsedAt).toBeNull();

    await service.verifyKey(created.key);
    const afterSuccess = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(afterSuccess.lastUsedAt).not.toBeNull();

    await service.revokeKey(testUserId, created.id);
    const lastUsedAtAfterRevoke = afterSuccess.lastUsedAt;
    await service.verifyKey(created.key);
    const afterFailedAttempt = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(afterFailedAttempt.lastUsedAt?.getTime()).toBe(lastUsedAtAfterRevoke?.getTime());
  });

  it("lists only the caller's own keys, newest first", async () => {
    const other = await prisma.user.create({
      data: { email: `other-${randomUUID()}@test.com`, password: 'hashed', role: 'fan' },
    });
    createdUserIds.push(other.id);

    await service.createKey(testUserId, { name: 'First', permissions: ['a'] });
    await service.createKey(testUserId, { name: 'Second', permissions: ['b'] });
    await service.createKey(other.id, { name: "Someone else's key", permissions: ['c'] });

    const keys = await service.listKeys(testUserId);
    expect(keys.map((k) => k.name)).toEqual(['Second', 'First']);
  });

  it('never returns the raw key value from listKeys', async () => {
    await service.createKey(testUserId, { name: 'No leak', permissions: ['a'] });
    const keys = await service.listKeys(testUserId);
    for (const key of keys) {
      expect(key).not.toHaveProperty('key');
    }
  });

  it('revoking an already-revoked key is idempotent', async () => {
    const created = await service.createKey(testUserId, {
      name: 'Double revoke',
      permissions: ['a'],
    });
    const first = await service.revokeKey(testUserId, created.id);
    const second = await service.revokeKey(testUserId, created.id);
    expect(first.revokedAt).toBe(second.revokedAt);
  });

  it('rejects revoking a key owned by a different user', async () => {
    const other = await prisma.user.create({
      data: { email: `other2-${randomUUID()}@test.com`, password: 'hashed', role: 'fan' },
    });
    createdUserIds.push(other.id);
    const created = await service.createKey(other.id, { name: 'Not yours', permissions: ['a'] });

    await expect(service.revokeKey(testUserId, created.id)).rejects.toThrow(NotFoundError);
  });

  it('rejects revoking an unknown key id', async () => {
    await expect(service.revokeKey(testUserId, 'does-not-exist')).rejects.toThrow(NotFoundError);
  });
});
