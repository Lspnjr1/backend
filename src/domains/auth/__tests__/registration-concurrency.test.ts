import { describe, it, expect, vi } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { AuthService } from '../auth.service';
import { CreatorService } from '../../creators/creator.service';
import { ConflictError } from '../../../utils/errors';

// Mock password hashing and emails to keep tests fast and isolated
vi.mock('../../../utils/password', () => ({
  hashPassword: vi.fn(async (p: string) => `hashed_${p}`),
  comparePasswords: vi.fn(async () => true),
}));

vi.mock('../../notifications/email', () => ({
  enqueueEmail: vi.fn(async () => 'job-1'),
}));

vi.mock('../../../lib/stellar', () => ({
  createFundedKeypair: vi.fn(async () => ({
    publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    secret: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })),
}));

vi.mock('../../../lib/encryption', () => ({
  encrypt: vi.fn((val: string) => `encrypted_${val}`),
  decrypt: vi.fn((val: string) => val.replace('encrypted_', '')),
}));

vi.mock('../../creators/creator.runtime', () => ({
  createCreatorTierRuntime: vi.fn(() => ({
    service: {
      ensureSubscription: vi.fn(),
    },
  })),
}));

describe('Issue #201: Unique constraints and race condition handling', () => {
  describe('User registration concurrency with identical email', () => {
    it('handles race condition when two requests register with the same email simultaneously', async () => {
      let createdCount = 0;
      const registeredEmails = new Set<string>();

      const mockPrisma = {
        user: {
          findUnique: vi.fn(async () => null), // Simultaneous findUnique: neither finds existing user before insert
          create: vi.fn(async ({ data }: { data: { email: string } }) => {
            if (registeredEmails.has(data.email)) {
              // Simulated database unique constraint violation (P2002)
              throw new PrismaClientKnownRequestError(
                'Unique constraint failed on the fields: (`email`)',
                {
                  code: 'P2002',
                  clientVersion: '5.20.0',
                  meta: { target: ['email'] },
                }
              );
            }
            registeredEmails.add(data.email);
            createdCount++;
            return {
              id: `user-${createdCount}`,
              email: data.email,
              name: 'Alice',
              authVersion: 1,
              twoFactorEnabled: false,
              isAnonymous: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          }),
        },
        verificationToken: {
          create: vi.fn(async () => ({ id: 'token-1' })),
        },
        $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockPrisma)),
      };

      const authService = new AuthService(mockPrisma as any);

      const req1 = authService.register({
        email: 'alice@example.com',
        password: 'Password123!',
        name: 'Alice A',
      });

      const req2 = authService.register({
        email: 'alice@example.com',
        password: 'Password123!',
        name: 'Alice B',
      });

      // Fire both requests concurrently
      const results = await Promise.allSettled([req1, req2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one succeeds
      expect(fulfilled).toHaveLength(1);
      // Exactly one fails with ConflictError (409)
      expect(rejected).toHaveLength(1);

      const failure = (rejected[0] as PromiseRejectedResult).reason;
      expect(failure).toBeInstanceOf(ConflictError);
      expect(failure.statusCode).toBe(409);
      expect(failure.message).toBe('Email already taken');
      expect(createdCount).toBe(1);
    });

    it('returns 409 ConflictError when findUnique detects existing email', async () => {
      const mockPrisma = {
        user: {
          findUnique: vi.fn(async () => ({ id: 'user-existing', email: 'taken@example.com' })),
          create: vi.fn(),
        },
      };

      const authService = new AuthService(mockPrisma as any);

      await expect(
        authService.register({
          email: 'taken@example.com',
          password: 'Password123!',
          name: 'Bob',
        })
      ).rejects.toThrow(ConflictError);

      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('Creator creation uniqueness on creator name/username', () => {
    it('catches database unique constraint violation and returns 409 Conflict', async () => {
      const mockPrisma = {
        creator: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async () => {
            throw new PrismaClientKnownRequestError(
              'Unique constraint failed on the fields: (`username`)',
              {
                code: 'P2002',
                clientVersion: '5.20.0',
                meta: { target: ['username'] },
              }
            );
          }),
        },
        user: {
          findUnique: vi.fn(async () => ({ id: 'user-1', name: 'User One', email: 'u1@example.com' })),
        },
      };

      const creatorService = new CreatorService(mockPrisma as any);

      await expect(
        creatorService.createCreator('user-1', {
          username: 'existing-creator',
          displayName: 'Existing Creator',
        })
      ).rejects.toThrow(ConflictError);

      try {
        await creatorService.createCreator('user-1', {
          username: 'existing-creator',
          displayName: 'Existing Creator',
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.statusCode).toBe(409);
        expect(err.message).toBe('Creator name already taken');
      }
    });
  });
});
