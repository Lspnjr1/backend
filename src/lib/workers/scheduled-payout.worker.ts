import { Worker, Job } from 'bullmq';
import { PrismaClient, ScheduledPaymentStatus } from '@prisma/client';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { PayoutService } from '../../domains/creators/payout.service';
import { ScheduledPayoutService } from '../../domains/creators/scheduled-payout.service';
import { withWorkerContext, runWithJobContext } from './middleware';

export interface ScheduledPayoutJobData {
  scheduledPaymentId: string;
  creatorId: string;
}

export interface ScheduledPayoutTriggerResult {
  scheduledPaymentId: string;
  triggered: boolean;
  payoutId?: string;
  skippedReason?: string;
}

/**
 * Triggers one run of a creator's scheduled payout (#222). This is the
 * processor BullMQ calls each time the job scheduler's cron expression fires
 * (see `ScheduledPayoutService.registerJobScheduler`, which registers the
 * recurring job via `Queue.upsertJobScheduler`).
 *
 * Reuses `PayoutService.processPayout` (the same path a manual payout
 * request takes) rather than building a second payout-execution mechanism, so
 * a scheduled payout is subject to exactly the same minimum-amount, wallet,
 * and balance rules a manual one is.
 *
 * Extracted from the BullMQ processor (same reasoning as `verifyTipBalance`
 * in `balance-verification.worker.ts`): constructing a `Worker` opens a
 * Redis connection immediately, which this session cannot exercise without a
 * live Redis instance, so the triggerable logic lives here where it is
 * testable against fake `PayoutService`/`ScheduledPayoutService`/prisma
 * doubles, and the actual end-to-end "cron fires against real Redis" path is
 * disclosed as unverified in the PR body rather than claimed as tested.
 */
export async function triggerScheduledPayout(
  prisma: Pick<PrismaClient, 'scheduledPayment' | 'creator'>,
  payoutService: Pick<PayoutService, 'processPayout'>,
  scheduledPayoutService: Pick<ScheduledPayoutService, 'recordRunOutcome'>,
  data: ScheduledPayoutJobData
): Promise<ScheduledPayoutTriggerResult> {
  const { scheduledPaymentId, creatorId } = data;

  const scheduled = await prisma.scheduledPayment.findUnique({ where: { id: scheduledPaymentId } });

  // The schedule could have been paused or cancelled between BullMQ deciding
  // to fire this run and the worker picking it up; a job scheduler is
  // removed on pause/cancel, but a run already enqueued before that removal
  // can still land here, so re-check status rather than trusting the queue.
  if (!scheduled || scheduled.status !== ScheduledPaymentStatus.active) {
    logger.info(
      { scheduledPaymentId, status: scheduled?.status },
      'Scheduled payout run skipped: schedule is no longer active'
    );
    return {
      scheduledPaymentId,
      triggered: false,
      skippedReason: scheduled ? `status is ${scheduled.status}` : 'schedule not found',
    };
  }

  try {
    const payout = await payoutService.processPayout(creatorId, {
      amount: scheduled.amount,
      walletAddress: scheduled.walletAddress ?? undefined,
    });

    await scheduledPayoutService.recordRunOutcome(scheduledPaymentId, { payoutId: payout.id });

    logger.info(
      { scheduledPaymentId, creatorId, payoutId: payout.id },
      'Scheduled payout triggered successfully'
    );

    return { scheduledPaymentId, triggered: true, payoutId: payout.id };
  } catch (error) {
    const message = (error as Error).message || 'Unknown error';
    await scheduledPayoutService.recordRunOutcome(scheduledPaymentId, { error: message });
    logger.error({ scheduledPaymentId, creatorId, error: message }, 'Scheduled payout run failed');
    throw error;
  }
}

export function createScheduledPayoutWorker(prisma: PrismaClient = new PrismaClient()) {
  const payoutService = new PayoutService(prisma);
  const scheduledPayoutService = new ScheduledPayoutService(prisma);

  const worker = new Worker(
    QUEUE_NAMES.scheduledPayout,
    withWorkerContext(async (job: Job) => {
      return triggerScheduledPayout(
        prisma,
        payoutService,
        scheduledPayoutService,
        job.data as ScheduledPayoutJobData
      );
    }),
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: { backoffStrategy },
    }
  );

  worker.on('completed', (job) => {
    runWithJobContext(job, () => {
      logger.info({ jobId: job.id }, 'Scheduled payout worker completed job');
    });
  });

  worker.on('failed', async (job, error) => {
    if (!job) {
      logger.error('Scheduled payout worker failed job:', error);
      return;
    }
    await runWithJobContext(job, async () => {
      logger.error(
        { jobId: job.id, scheduledPaymentId: job.data?.scheduledPaymentId, error: error.message },
        'Scheduled payout worker failed job'
      );
      if (job.attemptsMade >= (job.opts.attempts ?? 5)) {
        await moveToDeadLetter(
          QUEUE_NAMES.scheduledPayout,
          String(job.id),
          job.data,
          error.message
        );
      }
    });
  });

  return worker;
}
