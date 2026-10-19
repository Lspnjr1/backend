/**
 * GDPR data export and account deletion (issue #220).
 *
 * Export: builds a ZIP (containing a single JSON file with the user's full
 * exportable data) for download, replacing the old JSON/CSV-in-response
 * export.
 *
 * Deletion: no longer immediate. `requestDeletion` verifies the caller's
 * password (reusing the same bcrypt comparison used everywhere else in
 * `src/domains/auth`), then queues a BullMQ delayed job that performs the
 * actual deletion `DELETION_GRACE_PERIOD_DAYS` (30) days later. A
 * confirmation email with a cancellation link is sent immediately; the link
 * token is single-use and hashed at rest, mirroring the password-reset-token
 * pattern in `AuthService`. `cancelDeletion` removes the pending job and
 * marks the request cancelled any time before it fires.
 */
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient, ScheduledDeletionStatus } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../utils/errors';
import { comparePasswords } from '../../utils/password';
import { enqueueEmail } from '../notifications/email';
import { accountDeletionQueue } from '../../lib/queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

/** GDPR deletion grace period: time between the request and permanent deletion. */
export const DELETION_GRACE_PERIOD_DAYS = 30;
const DELETION_GRACE_PERIOD_MS = DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

const hashCancellationToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export interface DataExportResult {
  /** ZIP archive bytes, ready to stream as the HTTP response body. */
  buffer: Buffer;
  filename: string;
}

export interface ScheduledDeletionView {
  id: string;
  status: ScheduledDeletionStatus;
  requestedAt: string;
  scheduledFor: string;
  cancelledAt: string | null;
}

export class PrivacyService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Builds a ZIP archive containing the user's full exportable data as JSON.
   * Streams are buffered fully before returning: exports are infrequent,
   * per-user, rate-limited by `monthlyExports` elsewhere, and bounded in size,
   * so buffering keeps the route handler simple without risking memory abuse.
   */
  async exportUserDataAsZip(userId: string): Promise<DataExportResult> {
    return this.executeWithLogging('privacy.exportZip', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { wallets: true, creator: true, tips: true, payments: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      // Never let password hashes leave the service boundary, even inside an
      // export the user requested themselves.
      const { password: _password, ...safeUser } = user;

      const exportPayload = {
        exportedAt: new Date().toISOString(),
        user: safeUser,
        wallets: user.wallets,
        tips: user.tips,
        payments: user.payments,
      };

      const buffer = await this.buildZipBuffer('data.json', JSON.stringify(exportPayload, null, 2));

      logger.info({ userId }, 'GDPR data export generated');

      return {
        buffer,
        filename: 'dorisio-data-export.zip',
      };
    });
  }

  private buildZipBuffer(entryName: string, contents: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const stream = new PassThrough();
      const chunks: Buffer[] = [];

      stream.on('data', (chunk) => chunks.push(chunk as Buffer));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
      archive.on('error', reject);

      archive.pipe(stream);
      archive.append(contents, { name: entryName });
      void archive.finalize();
    });
  }

  /**
   * Verifies the caller's password, then schedules account deletion for
   * `DELETION_GRACE_PERIOD_DAYS` from now. Sends a confirmation email with a
   * cancellation link. Idempotent: a user with an existing pending deletion
   * gets the existing schedule back rather than a second, competing job.
   */
  async requestDeletion(userId: string, password: string): Promise<ScheduledDeletionView> {
    return this.executeWithLogging('privacy.requestDeletion', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, password: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const passwordMatches = await comparePasswords(password, user.password);
      if (!passwordMatches) {
        throw new UnauthorizedError('Incorrect password');
      }

      const existing = await this.prisma.scheduledAccountDeletion.findFirst({
        where: { userId, status: ScheduledDeletionStatus.pending },
      });
      if (existing) {
        logger.info(
          { userId, scheduledDeletionId: existing.id },
          'Deletion already scheduled; returning existing request'
        );
        return this.formatScheduledDeletion(existing);
      }

      const now = new Date();
      const scheduledFor = new Date(now.getTime() + DELETION_GRACE_PERIOD_MS);
      const rawToken = randomBytes(32).toString('hex');
      const cancellationTokenHash = hashCancellationToken(rawToken);

      const scheduled = await this.prisma.scheduledAccountDeletion.create({
        data: {
          userId,
          status: ScheduledDeletionStatus.pending,
          requestedAt: now,
          scheduledFor,
          cancellationTokenHash,
        },
      });

      // Delayed job, keyed by the deletion row's id so cancellation can remove
      // it by id before it fires.
      await accountDeletionQueue.add(
        'delete-account',
        { scheduledDeletionId: scheduled.id, userId },
        {
          jobId: scheduled.id,
          delay: DELETION_GRACE_PERIOD_MS,
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
        }
      );

      const cancelLink = `${config.FRONTEND_URL || 'http://localhost:3000'}/account/cancel-deletion?token=${rawToken}`;
      try {
        await enqueueEmail({
          to: user.email,
          template: 'account-deletion-scheduled',
          data: {
            name: user.name || 'there',
            link: cancelLink,
            scheduledFor: scheduledFor.toISOString(),
          },
          userId: user.id,
        });
      } catch (error) {
        logger.error({ userId, error }, 'Failed to queue account deletion confirmation email');
      }

      logger.info(
        { userId, scheduledDeletionId: scheduled.id, scheduledFor: scheduledFor.toISOString() },
        'Account deletion scheduled'
      );

      return this.formatScheduledDeletion(scheduled);
    });
  }

  /**
   * Cancels a pending deletion using the raw token from the confirmation
   * email's cancellation link. Removes the delayed BullMQ job so it never
   * fires, and marks the request cancelled. A token that does not match any
   * pending request (wrong, already used, or already executed) is rejected
   * without revealing which case it was.
   */
  async cancelDeletionByToken(rawToken: string): Promise<ScheduledDeletionView> {
    return this.executeWithLogging('privacy.cancelDeletion', async () => {
      const tokenHash = hashCancellationToken(rawToken);
      const scheduled = await this.prisma.scheduledAccountDeletion.findUnique({
        where: { cancellationTokenHash: tokenHash },
      });

      if (!scheduled || scheduled.status !== ScheduledDeletionStatus.pending) {
        throw new ValidationError('This cancellation link is invalid or has expired');
      }

      if (scheduled.scheduledFor.getTime() <= Date.now()) {
        throw new ConflictError('This deletion can no longer be cancelled');
      }

      await accountDeletionQueue.remove(scheduled.id);

      const cancelled = await this.prisma.scheduledAccountDeletion.update({
        where: { id: scheduled.id },
        data: { status: ScheduledDeletionStatus.cancelled, cancelledAt: new Date() },
      });

      logger.info(
        { userId: scheduled.userId, scheduledDeletionId: scheduled.id },
        'Account deletion cancelled'
      );

      return this.formatScheduledDeletion(cancelled);
    });
  }

  /** Current pending deletion for a user, if any (used by the status route). */
  async getPendingDeletion(userId: string): Promise<ScheduledDeletionView | null> {
    return this.executeWithLogging('privacy.getPendingDeletion', async () => {
      const scheduled = await this.prisma.scheduledAccountDeletion.findFirst({
        where: { userId, status: ScheduledDeletionStatus.pending },
        orderBy: { createdAt: 'desc' },
      });
      return scheduled ? this.formatScheduledDeletion(scheduled) : null;
    });
  }

  /**
   * Executes a previously scheduled deletion. Called by the worker once the
   * delayed job fires (30 days after the request); idempotent against a
   * deletion that was cancelled or already completed in the meantime.
   */
  async executeScheduledDeletion(scheduledDeletionId: string): Promise<void> {
    return this.executeWithLogging('privacy.executeScheduledDeletion', async () => {
      const scheduled = await this.prisma.scheduledAccountDeletion.findUnique({
        where: { id: scheduledDeletionId },
      });

      if (!scheduled || scheduled.status !== ScheduledDeletionStatus.pending) {
        logger.info(
          { scheduledDeletionId, status: scheduled?.status },
          'Scheduled deletion skipped: no longer pending (cancelled or already completed)'
        );
        return;
      }

      const tombstone = `deleted-${scheduled.userId}@privacy.invalid`;
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: scheduled.userId },
          data: {
            email: tombstone,
            password: randomBytes(32).toString('hex'),
            name: null,
            verified: false,
            notificationPreferences: {},
          },
        }),
        this.prisma.wallet.deleteMany({ where: { userId: scheduled.userId } }),
        this.prisma.scheduledAccountDeletion.update({
          where: { id: scheduledDeletionId },
          data: { status: ScheduledDeletionStatus.completed, completedAt: new Date() },
        }),
      ]);

      logger.info(
        { userId: scheduled.userId, scheduledDeletionId },
        'Scheduled account deletion executed'
      );
    });
  }

  private formatScheduledDeletion(scheduled: {
    id: string;
    status: ScheduledDeletionStatus;
    requestedAt: Date;
    scheduledFor: Date;
    cancelledAt: Date | null;
  }): ScheduledDeletionView {
    return {
      id: scheduled.id,
      status: scheduled.status,
      requestedAt: scheduled.requestedAt.toISOString(),
      scheduledFor: scheduled.scheduledFor.toISOString(),
      cancelledAt: scheduled.cancelledAt ? scheduled.cancelledAt.toISOString() : null,
    };
  }
}
