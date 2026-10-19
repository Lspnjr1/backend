import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserService } from '../user.service';
import { AuthService } from '../../auth/auth.service';
import { ValidationError, ConflictError, NotFoundError } from '../../../utils/errors';
import * as emailNotificationModule from '../../notifications/email';

describe('Email verification before sensitive operations (#196)', () => {
  let mockPrisma: any;
  let userService: UserService;
  let authService: AuthService;
  let enqueueEmailSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma = {
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      pendingEmailChange: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn(),
        update: vi.fn(),
      },
      profileChange: {
        createMany: vi.fn(),
      },
      authAttempt: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (arg) => {
        if (typeof arg === 'function') {
          return arg(mockPrisma);
        }
        return Promise.all(arg);
      }),
    };

    userService = new UserService(mockPrisma as any);
    authService = new AuthService(mockPrisma as any);
    enqueueEmailSpy = vi.spyOn(emailNotificationModule, 'enqueueEmail').mockResolvedValue('job-123');
  });

  describe('requestEmailChange', () => {
    it('creates an unverified PendingEmailChange with 24h expiry and sends verification link', async () => {
      mockPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === 'user-1') {
          return { id: 'user-1', email: 'old@example.com', name: 'Alice' };
        }
        if (where.email === 'new@example.com') {
          return null; // Not taken
        }
        return null;
      });
      mockPrisma.pendingEmailChange.findFirst.mockResolvedValue(null);
      mockPrisma.pendingEmailChange.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.pendingEmailChange.create.mockImplementation(async ({ data }: any) => ({
        id: 'pending-1',
        ...data,
      }));

      const result = await userService.requestEmailChange('user-1', 'new@example.com', {
        ip: '127.0.0.1',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Verification link sent');
      expect(mockPrisma.pendingEmailChange.create).toHaveBeenCalledTimes(1);

      const createCall = mockPrisma.pendingEmailChange.create.mock.calls[0][0].data;
      expect(createCall.userId).toBe('user-1');
      expect(createCall.oldEmail).toBe('old@example.com');
      expect(createCall.newEmail).toBe('new@example.com');
      expect(createCall.token).toBeDefined();

      // Check token expires ~24 hours from now
      const expiresAt = new Date(createCall.expiresAt).getTime();
      const now = Date.now();
      expect(expiresAt - now).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(expiresAt - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000);

      // Verify email was enqueued to the NEW email
      expect(enqueueEmailSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'new@example.com',
          template: 'verification',
          data: expect.objectContaining({
            link: expect.stringContaining(createCall.token),
          }),
        })
      );
    });

    it('rejects if new email is identical to current email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'same@example.com',
        name: 'Alice',
      });

      await expect(
        userService.requestEmailChange('user-1', 'same@example.com')
      ).rejects.toThrow(ValidationError);
    });

    it('returns 409 Conflict if new email is already taken by another user', async () => {
      mockPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === 'user-1') {
          return { id: 'user-1', email: 'alice@example.com', name: 'Alice' };
        }
        if (where.email === 'taken@example.com') {
          return { id: 'user-2', email: 'taken@example.com' };
        }
        return null;
      });

      await expect(
        userService.requestEmailChange('user-1', 'taken@example.com')
      ).rejects.toThrow(ConflictError);
    });

    it('rejects invalid email formats', async () => {
      await expect(userService.requestEmailChange('user-1', 'invalid-email')).rejects.toThrow(
        ValidationError
      );
    });
  });

  describe('verifyEmailChange', () => {
    it('successfully updates user.email and marks change verified', async () => {
      const validToken = 'valid-token-123';
      const futureDate = new Date(Date.now() + 12 * 60 * 60 * 1000);

      mockPrisma.pendingEmailChange.findUnique.mockResolvedValue({
        id: 'pending-1',
        userId: 'user-1',
        oldEmail: 'old@example.com',
        newEmail: 'new@example.com',
        token: validToken,
        expiresAt: futureDate,
        verifiedAt: null,
      });

      mockPrisma.user.findUnique.mockResolvedValue(null); // not claimed by anyone else
      mockPrisma.user.update.mockResolvedValue({ id: 'user-1', email: 'new@example.com' });
      mockPrisma.pendingEmailChange.update.mockResolvedValue({ id: 'pending-1', verifiedAt: new Date() });
      mockPrisma.profileChange.createMany.mockResolvedValue({ count: 1 });

      const result = await userService.verifyEmailChange(validToken, { ip: '127.0.0.1' });

      expect(result.success).toBe(true);
      expect(result.email).toBe('new@example.com');

      // Verify transaction updated user.email
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { email: 'new@example.com' },
      });

      // Verify pending change was marked verified
      expect(mockPrisma.pendingEmailChange.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pending-1' },
          data: expect.objectContaining({ verifiedAt: expect.any(Date) }),
        })
      );

      // Verify audit trail logged the change
      expect(mockPrisma.profileChange.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              userId: 'user-1',
              field: 'email',
              oldValue: 'old@example.com',
              newValue: 'new@example.com',
              sensitive: true,
            }),
          ]),
        })
      );
    });

    it('rejects expired verification tokens', async () => {
      const pastDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago

      mockPrisma.pendingEmailChange.findUnique.mockResolvedValue({
        id: 'pending-1',
        userId: 'user-1',
        oldEmail: 'old@example.com',
        newEmail: 'new@example.com',
        token: 'expired-token',
        expiresAt: pastDate,
        verifiedAt: null,
      });

      await expect(userService.verifyEmailChange('expired-token')).rejects.toThrow(
        'Verification token has expired'
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects already verified tokens', async () => {
      mockPrisma.pendingEmailChange.findUnique.mockResolvedValue({
        id: 'pending-1',
        userId: 'user-1',
        oldEmail: 'old@example.com',
        newEmail: 'new@example.com',
        token: 'used-token',
        expiresAt: new Date(Date.now() + 10000),
        verifiedAt: new Date(),
      });

      await expect(userService.verifyEmailChange('used-token')).rejects.toThrow(
        'Verification token has already been used'
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects unknown or invalid tokens', async () => {
      mockPrisma.pendingEmailChange.findUnique.mockResolvedValue(null);

      await expect(userService.verifyEmailChange('nonexistent-token')).rejects.toThrow(
        ValidationError
      );
    });
  });

  describe('attempted access logging for unverified emails', () => {
    it('flags and logs when login is attempted with an unverified pending email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.pendingEmailChange.findFirst.mockResolvedValue({
        id: 'pending-1',
        userId: 'user-1',
        newEmail: 'unverified@example.com',
        verifiedAt: null,
      });

      await expect(
        authService.login(
          { email: 'unverified@example.com', password: 'Password123!' },
          { ipAddress: '192.168.1.1' }
        )
      ).rejects.toThrow(ValidationError);

      expect(mockPrisma.authAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'unverified@example.com',
          reason: 'unverified_pending_email',
        }),
      });
    });
  });
});
