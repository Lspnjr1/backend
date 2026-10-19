import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { logger } from '../../utils/logger';
import { PrivacyService } from '../../domains/privacy/privacy.service';
import { withWorkerContext, runWithJobContext } from './middleware';

/**
 * Executes a GDPR account deletion once its 30-day grace period (BullMQ
 * `delay`) has elapsed (#220). The job is enqueued by
 * `PrivacyService.requestDeletion` with `jobId` set to the
 * `ScheduledAccountDeletion` row id, so cancelling the request (removing the
 * job by id) before this runs prevents it from ever firing.
 *
 * `PrivacyService.executeScheduledDeletion` re-checks the row's status before
 * doing anything, so this is also safe against a cancellation that races a
 * job already picked up for processing.
 */
export function createAccountDeletionWorker(prisma: PrismaClient = new PrismaClient()) {
  const privacyService = new PrivacyService(prisma);

  const worker = new Worker(
    QUEUE_NAMES.accountDeletion,
    withWorkerContext(async (job: Job) => {
      const { scheduledDeletionId, userId } = job.data as {
        scheduledDeletionId: string;
        userId: string;
      };

      logger.info({ scheduledDeletionId, userId }, 'Executing scheduled account deletion');
      await privacyService.executeScheduledDeletion(scheduledDeletionId);

      return { scheduledDeletionId, userId, executed: true };
    }),
    {
      connection: bullConnection,
      concurrency: 1,
      settings: { backoffStrategy },
    }
  );

  worker.on('completed', (job) => {
    runWithJobContext(job, () => {
      logger.info({ jobId: job.id }, 'Account deletion worker completed job');
    });
  });

  worker.on('failed', async (job, error) => {
    if (!job) {
      logger.error('Account deletion worker failed job:', error);
      return;
    }
    await runWithJobContext(job, async () => {
      logger.error({ jobId: job.id, error: error.message }, 'Account deletion worker failed job');
      if (job.attemptsMade >= (job.opts.attempts ?? 5)) {
        await moveToDeadLetter(
          QUEUE_NAMES.accountDeletion,
          String(job.id),
          job.data,
          error.message
        );
      }
    });
  });

  return worker;
}
