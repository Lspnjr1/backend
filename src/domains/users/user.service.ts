import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import {
  ChangePasswordRequest,
  ChangePasswordResponse,
  PaginatedProfileChanges,
  ProfileChangeResponse,
  UpdateUserProfileRequest,
  UpdateUserSettingsRequest,
  UserProfileResponse,
  UserSettingsResponse,
  UserTransactionHistoryResponse,
  PaginatedTransactions,
  parsePhone,
} from './user.types';
import { ValidationError, NotFoundError, ConflictError } from '../../utils/errors';
import { getOrFetch, invalidate, update, createCacheKey, CacheType } from '../../lib/cache/cache-aside';
import { DEFAULT_PAGE_SIZE, sanitizePageNumber, sanitizePageSize } from '../../utils/pagination';
import { comparePasswords, hashPassword } from '../../utils/password';
import { blacklistToken } from '../../utils/token-blacklist';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { storeAvatar } from './avatar.storage';
import { recordQueryTiming } from '../../db/prisma-performance';
import { randomBytes } from 'crypto';
import { enqueueEmail } from '../notifications/email';
import { parseExpiryToMs } from '../auth/auth.service';

/** Columns exposed by the public user profile (never the password hash). */
const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  bio: true,
  phoneNumber: true,
  avatar: true,
  role: true,
  verified: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DEFAULT_SETTINGS = {
  notificationsEnabled: true,
  emailDigest: 'weekly',
} as const;

/** Fields whose changes are flagged as security sensitive in the audit trail. */
const SENSITIVE_AUDIT_FIELDS = new Set(['password', 'email', 'phoneNumber', 'avatar']);

/** Request metadata captured alongside an audited change. */
export interface ProfileRequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

interface ProfileChangeInput {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export class UserService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async getUserProfile(userId: string): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.getProfile', async () => {
      const cacheKey = createCacheKey(CacheType.USER, userId);

      return getOrFetch({
        key: cacheKey,
        type: CacheType.USER,
        fetchFn: async () => {
          const start = Date.now();
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: USER_PROFILE_SELECT,
          });
          recordQueryTiming('user.getProfile', Date.now() - start);

          if (!user) {
            throw new NotFoundError('User');
          }

          return this.formatUserProfile(user);
        },
      });
    });
  }

  async updateUserProfile(
    userId: string,
    data: UpdateUserProfileRequest,
    context: ProfileRequestContext = {}
  ): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.updateProfile', async () => {
      // Email is intentionally absent from the update schema; reject it
      // explicitly so a client cannot silently mutate the login identifier.
      if (Object.prototype.hasOwnProperty.call(data, 'email')) {
        throw new ValidationError(
          'Email cannot be changed here; use the email verification flow'
        );
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, bio: true, phoneNumber: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      let phoneValue: string | null | undefined;
      if (data.phoneNumber !== undefined) {
        if (data.phoneNumber === null) {
          phoneValue = null;
        } else {
          const normalized = parsePhone(String(data.phoneNumber));
          if (normalized === null) {
            throw new ValidationError('Invalid phone number format');
          }
          phoneValue = normalized;
        }
      }

      const changes: ProfileChangeInput[] = [];
      if (data.name !== undefined && data.name !== user.name) {
        changes.push({ field: 'name', oldValue: user.name, newValue: data.name });
      }
      if (data.bio !== undefined && data.bio !== user.bio) {
        changes.push({ field: 'bio', oldValue: user.bio, newValue: data.bio });
      }
      if (phoneValue !== undefined && phoneValue !== user.phoneNumber) {
        changes.push({
          field: 'phoneNumber',
          oldValue: user.phoneNumber,
          newValue: phoneValue,
        });
      }

      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.bio !== undefined ? { bio: data.bio } : {}),
          ...(phoneValue !== undefined ? { phoneNumber: phoneValue } : {}),
        },
        select: USER_PROFILE_SELECT,
      });

      if (changes.length > 0) {
        await this.recordProfileChanges(userId, changes, context);
      }

      const cacheKey = createCacheKey(CacheType.USER, userId);
      await update(cacheKey, this.formatUserProfile(updatedUser), CacheType.USER);
      // Settings are derived from the same row; drop the cached copy so the
      // next read re-evaluates against fresh data.
      await invalidate(createCacheKey(CacheType.USER, `${userId}:settings`));

      return this.formatUserProfile(updatedUser);
    });
  }

  /**
   * Change a password after verifying the current one. Distinct from the
   * forgot/reset flow: the caller proves ownership with the existing password.
   * The caller's access token is revoked so a leaked token cannot outlive the
   * rotation.
   */
  async changePassword(
    userId: string,
    data: ChangePasswordRequest,
    context: ProfileRequestContext = {},
    accessToken?: string
  ): Promise<ChangePasswordResponse> {
    return this.executeWithLogging('user.changePassword', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {id: true, password: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const currentPasswordMatches = await comparePasswords(data.currentPassword, user.password);
      if (!currentPasswordMatches) {
        throw new ValidationError('Current password is incorrect');
      }

      const hashedPassword = await hashPassword(data.newPassword);
      await this.prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      // Never store the password (or its hash) in the audit trail — only that
      // it changed, plus who/when/from where.
      await this.recordProfileChanges(
        userId,
        [{ field: 'password', oldValue: null, newValue: null }],
        context
      );

      logger.warn('Security-sensitive change: user password updated', {
        userId,
        ip: context.ip ?? undefined,
      });

      if (accessToken) {
        const expiresAt = new Date(Date.now() + parseExpiryToMs(config.JWT_EXPIRES_IN));
        await blacklistToken(accessToken, expiresAt);
      }

      await invalidate(createCacheKey(CacheType.USER, userId));

      return { success: true, message: 'Password updated successfully' };
    });
  }

  async getUserSettings(userId: string): Promise<UserSettingsResponse> {
    return this.executeWithLogging('user.getSettings', async () => {
      const cacheKey = createCacheKey(CacheType.USER, `${userId}:settings`);

      return getOrFetch({
        key: cacheKey,
        type: CacheType.USER,
        fetchFn: async () => {
          const start = Date.now();
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {id: true, notificationPreferences: true },
          });
          recordQueryTiming('user.getSettings', Date.now() - start);

          if (!user) {
            throw new NotFoundError('User');
          }

          return this.formatUserSettings(userId, user.notificationPreferences);
        },
      });
    });
  }

  async updateUserSettings(
    userId: string,
    data: UpdateUserSettingsRequest,
    context: ProfileRequestContext = {}
  ): Promise<UserSettingsResponse> {
    return this.executeWithLogging('user.updateSettings', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, notificationPreferences: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const current = this.formatUserSettings(userId, user.notificationPreferences);
      const updatedSettings: UserSettingsResponse = {
        userId,
        notificationsEnabled: data.notificationsEnabled ?? current.notificationsEnabled,
        emailDigest: data.emailDigest ?? current.emailDigest,
      };

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          notificationPreferences: {
            notificationsEnabled: updatedSettings.notificationsEnabled,
            emailDigest: updatedSettings.emailDigest,
          },
        },
      });

      const changes: ProfileChangeInput[] = [];
      if (updatedSettings.notificationsEnabled !== current.notificationsEnabled) {
        changes.push({
          field: 'notificationsEnabled',
          oldValue: String(current.notificationsEnabled),
          newValue: String(updatedSettings.notificationsEnabled),
        });
      }
      if (updatedSettings.emailDigest !== current.emailDigest) {
        changes.push({
          field: 'emailDigest',
          oldValue: current.emailDigest,
          newValue: updatedSettings.emailDigest,
        });
      }
      if (changes.length > 0) {
        await this.recordProfileChanges(userId, changes, context);
      }

      const cacheKey = createCacheKey(CacheType.USER, `${userId}:settings`);
      await update(cacheKey, updatedSettings, CacheType.USER);

      return updatedSettings;
    });
  }

  /**
   * Store an uploaded avatar and point the profile at it. The image is
   * validated (JPEG/PNG, up to 5MB) before anything is written.
   */
  async updateAvatar(
    userId: string,
    image: string,
    context: ProfileRequestContext = {}
  ): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.updateAvatar', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, avatar: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const avatarUrl = await storeAvatar(userId, image);
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: { avatar: avatarUrl },
        select: USER_PROFILE_SELECT,
      });

      await this.recordProfileChanges(
        userId,
        [{ field: 'avatar', oldValue: user.avatar, newValue: avatarUrl }],
        context
      );

      const cacheKey = createCacheKey(CacheType.USER, userId);
      await update(cacheKey, this.formatUserProfile(updatedUser), CacheType.USER);

      return this.formatUserProfile(updatedUser);
    });
  }

  /**
   * Initiates an email change by creating an unverified PendingEmailChange and sending
   * a verification link to the new email address. User's email is NOT updated until verified (#196).
   */
  async requestEmailChange(
    userId: string,
    newEmailInput: string,
    context: ProfileRequestContext = {}
  ): Promise<{ success: true; message: string; expiresAt: string }> {
    return this.executeWithLogging('user.requestEmailChange', async () => {
      const newEmail = newEmailInput.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        throw new ValidationError('Invalid email format');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      if (user.email.toLowerCase() === newEmail) {
        throw new ValidationError('New email must be different from current email');
      }

      // Check if another user already has this email
      const existingUser = await this.prisma.user.findUnique({
        where: { email: newEmail },
        select: { id: true },
      });

      if (existingUser) {
        throw new ConflictError('Email already taken');
      }

      // Check for active pending change for another user on the same target email
      const existingPending = await this.prisma.pendingEmailChange.findFirst({
        where: {
          newEmail,
          expiresAt: { gt: new Date() },
          verifiedAt: null,
          userId: { not: userId },
        },
      });

      if (existingPending) {
        throw new ConflictError('Email already taken');
      }

      // Invalidate any previously unverified change requests for this user
      await this.prisma.pendingEmailChange.deleteMany({
        where: { userId, verifiedAt: null },
      });

      // Generate secure token valid for 24 hours
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await this.prisma.pendingEmailChange.create({
        data: {
          userId,
          oldEmail: user.email,
          newEmail,
          token,
          expiresAt,
        },
      });

      const verificationLink = `${config.FRONTEND_URL || 'http://localhost:3000'}/verify-email-change?token=${token}`;

      try {
        await enqueueEmail({
          to: newEmail,
          template: 'verification',
          data: {
            name: user.name || 'there',
            link: verificationLink,
          },
        });
      } catch (err) {
        logger.error({ err, userId, newEmail }, 'Failed to enqueue email change verification message');
      }

      logger.info(
        { userId, oldEmail: user.email, newEmail, ip: context.ip },
        'Pending email change initiated; verification link sent to new email'
      );

      return {
        success: true,
        message: 'Verification link sent to new email address',
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /**
   * Confirms email change using the token sent to the new email address.
   * Only upon successful verification is user.email updated in the database (#196).
   */
  async verifyEmailChange(
    tokenInput: string,
    context: ProfileRequestContext = {}
  ): Promise<{ success: true; message: string; email: string }> {
    return this.executeWithLogging('user.verifyEmailChange', async () => {
      const token = tokenInput?.trim();
      if (!token) {
        throw new ValidationError('Verification token is required');
      }

      const pending = await this.prisma.pendingEmailChange.findUnique({
        where: { token },
      });

      if (!pending) {
        logger.warn({ token, ip: context.ip }, 'Attempted access/verification with invalid email change token');
        throw new ValidationError('Invalid or expired verification token');
      }

      if (pending.verifiedAt) {
        throw new ValidationError('Verification token has already been used');
      }

      if (pending.expiresAt.getTime() < Date.now()) {
        logger.warn(
          { userId: pending.userId, newEmail: pending.newEmail, ip: context.ip },
          'Attempted email change verification with expired token'
        );
        throw new ValidationError('Verification token has expired');
      }

      // Check if new email was claimed by another user in the interim
      const emailConflict = await this.prisma.user.findUnique({
        where: { email: pending.newEmail },
        select: { id: true },
      });

      if (emailConflict && emailConflict.id !== pending.userId) {
        throw new ConflictError('Email already taken');
      }

      // Atomically update user email and mark pending change verified
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: pending.userId },
          data: { email: pending.newEmail },
        }),
        this.prisma.pendingEmailChange.update({
          where: { id: pending.id },
          data: { verifiedAt: new Date() },
        }),
      ]);

      // Record in audit log
      await this.recordProfileChanges(
        pending.userId,
        [{ field: 'email', oldValue: pending.oldEmail, newValue: pending.newEmail }],
        context
      );

      // Invalidate user cache
      const cacheKey = createCacheKey(CacheType.USER, pending.userId);
      await invalidate(cacheKey);

      logger.info(
        { userId: pending.userId, oldEmail: pending.oldEmail, newEmail: pending.newEmail, ip: context.ip },
        'Email change successfully verified and user record updated'
      );

      return {
        success: true,
        message: 'Email address verified and updated successfully',
        email: pending.newEmail,
      };
    });
  }

  /** Paginated audit trail for a user's profile changes, newest first. */
  async getProfileChanges(
    userId: string,
    page: number = 1,
    pageSize: number = 20
  ): Promise<PaginatedProfileChanges> {
    return this.executeWithLogging('user.getProfileChanges', async () => {
      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, DEFAULT_PAGE_SIZE);
      const skip = (safePage - 1) * safePageSize;

      const start = Date.now();
      const [rows, total] = await Promise.all([
        this.prisma.profileChange.findMany({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: safePageSize,
        }),
        this.prisma.profileChange.count({ where: { userId } }),
      ]);
      recordQueryTiming('user.getProfileChanges', Date.now() - start);

      const changes: ProfileChangeResponse[] = rows.map((row) => ({
        id: row.id,
        field: row.field,
        oldValue: row.oldValue,
        newValue: row.newValue,
        sensitive: row.sensitive,
        createdAt: row.createdAt.toISOString(),
      }));

      return {
        changes,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
      };
    });
  }

  async getUserTransactionHistory(
    userId: string,
    page: number = 1,
    pageSize: number = 20
  ): Promise<PaginatedTransactions> {
    return this.executeWithLogging('user.getTransactionHistory', async () => {
      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, DEFAULT_PAGE_SIZE);
      const skip = (safePage - 1) * safePageSize;

      const start = Date.now();
      const [rows, total] = await Promise.all([
        this.prisma.tip.findMany({
          where: { fromUserId: userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: safePageSize,
        }),
        this.prisma.tip.count({ where: { fromUserId: userId } }),
      ]);
      recordQueryTiming('user.getTransactionHistory', Date.now() - start);

      return {
        transactions: rows as unknown as UserTransactionHistoryResponse[],
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
      };
    });
  }

  private async recordProfileChanges(
    userId: string,
    changes: ProfileChangeInput[],
    context: ProfileRequestContext
  ): Promise<void> {
    await this.prisma.profileChange.createMany({
      data: changes.map((change) => ({
        userId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        sensitive: SENSITIVE_AUDIT_FIELDS.has(change.field),
        ip: context.ip ?? null,
        ipAddress: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      })),
    });
  }

  private formatUserProfile(user: {
    id: string;
    email: string;
    name: string | null;
    bio: string | null;
    phoneNumber: string | null;
    avatar: string | null;
    role: string;
    verified: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): UserProfileResponse {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      bio: user.bio,
      phoneNumber: user.phoneNumber,
      avatar: user.avatar,
      role: user.role,
      verified: user.verified,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    } as unknown as UserProfileResponse;
  }

  private formatUserSettings(
    userId: string,
    prefs: unknown | null
  ): UserSettingsResponse {
    const p = (prefs ?? {}) as Record<string, unknown>;
    return {
      userId,
      notificationsEnabled:
        typeof p.notificationsEnabled === 'boolean'
          ? (p.notificationsEnabled as boolean)
          : DEFAULT_SETTINGS.notificationsEnabled,
      emailDigest:
        typeof p.emailDigest === 'string'
          ? (p.emailDigest as string)
          : DEFAULT_SETTINGS.emailDigest,
    } as unknown as UserSettingsResponse;
  }
}
