import { createHmac, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TwoFactorService } from '../two-factor.service';
import { ValidationError } from '../../../utils/errors';

let prisma: PrismaClient;
let service: TwoFactorService;
const createdUserIds: string[] = [];
let testUserId: string;
const isDbAvailable = Boolean(process.env.DATABASE_URL);
let dbReachable = false;

describe.skipIf(!isDbAvailable)('TwoFactorService backup code confirmation (issue #214)', () => {
  beforeAll(async () => {
    if (!isDbAvailable) {
      console.warn('DATABASE_URL not set, skipping TwoFactorService tests');
      return;
    }
    try {
      prisma = new PrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      dbReachable = true;
      service = new TwoFactorService(prisma);
    } catch {
      console.warn('Database connection failed, skipping TwoFactorService tests');
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    if (!dbReachable) {
      await prisma.$disconnect().catch(() => undefined);
      return;
    }
    try {
      await prisma.twoFactorEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.twoFactorAuth.deleteMany({ where: { userId: { in: createdUserIds } } });
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
        email: `2fa-${randomUUID()}@test.com`,
        password: 'hashed-password',
        name: 'Test User',
        role: 'fan',
      },
    });
    testUserId = user.id;
    createdUserIds.push(user.id);
  });

  it('cannot be enabled before backup codes are confirmed, even with a valid TOTP code', async () => {
    const setup = await service.setup(testUserId);
    const totpCode = validTotpCode(setup.secret);

    await expect(service.enable(testUserId, totpCode)).rejects.toThrow(ValidationError);
  });

  it('can be enabled once backup codes are confirmed', async () => {
    const setup = await service.setup(testUserId);
    await service.confirmBackupCodes(testUserId, setup.backupCodes[0]);

    const totpCode = validTotpCode(setup.secret);
    const result = await service.enable(testUserId, totpCode);
    expect(result).toEqual({ enabled: true });
  });

  it('rejects confirmation with a code that was never issued', async () => {
    await service.setup(testUserId);
    await expect(service.confirmBackupCodes(testUserId, 'not-a-real-code')).rejects.toThrow(
      ValidationError
    );
  });

  it('confirming a backup code does not consume it', async () => {
    const setup = await service.setup(testUserId);
    await service.confirmBackupCodes(testUserId, setup.backupCodes[0]);

    const record = await prisma.twoFactorAuth.findUniqueOrThrow({ where: { userId: testUserId } });
    expect(record.backupCodes).toHaveLength(10);
  });

  it('regenerating backup codes requires a valid 2FA code', async () => {
    const setup = await service.setup(testUserId);
    await service.confirmBackupCodes(testUserId, setup.backupCodes[0]);
    await service.enable(testUserId, validTotpCode(setup.secret));

    await expect(service.regenerateBackupCodes(testUserId, 'wrong-code')).rejects.toThrow(
      ValidationError
    );
  });

  it('regenerating backup codes with a valid backup code issues a fresh set and resets confirmation', async () => {
    const setup = await service.setup(testUserId);
    await service.confirmBackupCodes(testUserId, setup.backupCodes[0]);
    await service.enable(testUserId, validTotpCode(setup.secret));

    const regenerated = await service.regenerateBackupCodes(testUserId, setup.backupCodes[1]);
    expect(regenerated.backupCodes).toHaveLength(10);
    expect(regenerated.backupCodes).not.toEqual(setup.backupCodes);

    const record = await prisma.twoFactorAuth.findUniqueOrThrow({ where: { userId: testUserId } });
    expect(record.backupCodesConfirmed).toBe(false);
  });

  it('regenerating backup codes requires reconfirmation before the account can be re-enabled', async () => {
    const setup = await service.setup(testUserId);
    await service.confirmBackupCodes(testUserId, setup.backupCodes[0]);
    await service.enable(testUserId, validTotpCode(setup.secret));
    await service.disable(testUserId, validTotpCode(setup.secret));

    const regenerated = await service.regenerateBackupCodes(testUserId, setup.backupCodes[1]);

    await expect(service.enable(testUserId, validTotpCode(setup.secret))).rejects.toThrow(
      ValidationError
    );

    await service.confirmBackupCodes(testUserId, regenerated.backupCodes[0]);
    const result = await service.enable(testUserId, validTotpCode(setup.secret));
    expect(result).toEqual({ enabled: true });
  });

  it('setup resets backupCodesConfirmed back to false for a repeat setup', async () => {
    const first = await service.setup(testUserId);
    await service.confirmBackupCodes(testUserId, first.backupCodes[0]);

    await service.setup(testUserId);
    const record = await prisma.twoFactorAuth.findUniqueOrThrow({ where: { userId: testUserId } });
    expect(record.backupCodesConfirmed).toBe(false);
  });
});

/**
 * Independently reimplements two-factor.service.ts's private `codeFor`
 * (same base32 alphabet, same HOTP construction), rather than brute-forcing
 * the 6-digit space against `verifyTotp` or exporting internals purely for
 * this test's benefit.
 */
function decodeBase32(value: string): Buffer {
  return Buffer.from(value.replace(/=+$/g, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function validTotpCode(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 30_000);
  const digest = createHmac('sha1', decodeBase32(secret))
    .update(Buffer.from(counter.toString(16).padStart(16, '0'), 'hex'))
    .digest();
  const offset = digest[digest.length - 1] & 0xf;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return number.toString().padStart(6, '0');
}
