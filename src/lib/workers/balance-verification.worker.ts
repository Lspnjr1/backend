import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { getWalletBalance } from '../stellar/wallet';
import { PaymentService } from '../../domains/payments/payment.service';
import { TipStatus } from '../../domains/payments/payment.types';
import { withWorkerContext, runWithJobContext } from './middleware';

/** Terminal tip states: a tip in one of these no longer accepts verification. */
const TERMINAL_TIP_STATUSES: string[] = [
  TipStatus.COMPLETED,
  TipStatus.FAILED,
  TipStatus.CANCELLED,
];

export interface BalanceVerificationJobData {
  tipId: string;
  walletPublicKey: string;
  assetCode: string;
  requiredAmount: number;
}

export interface BalanceVerificationResult {
  tipId: string;
  skipped?: boolean;
  status?: string;
  sufficient?: boolean;
  currentBalance?: number;
  requiredAmount?: number;
}

/**
 * Verifies on-chain wallet balance for a tip after it has already been
 * created (#221). Tip creation used to make this Stellar Horizon RPC call
 * synchronously, before creating any database record (#175); under network
 * congestion that call could be slow enough to time out the whole request,
 * turning a congested network into a failed payment even when the sender had
 * ample funds. The tip is now created immediately in PENDING state, and this
 * function performs the same balance check (and the same insufficient-funds
 * rule) afterwards, transitioning the tip to FAILED if the check fails.
 *
 * Extracted from the BullMQ processor so it can be unit tested directly: a
 * `bullmq` `Worker` opens a Redis connection the moment it is constructed,
 * which this session has no live Redis to exercise, so the actual
 * job-processing logic lives here where it is testable with a mocked
 * `PaymentService`/`getWalletBalance`, and `createBalanceVerificationWorker`
 * below is a thin, intentionally untested orchestration layer around it.
 */
export async function verifyTipBalance(
  paymentService: PaymentService,
  data: BalanceVerificationJobData
): Promise<BalanceVerificationResult> {
  const { tipId, walletPublicKey, assetCode, requiredAmount } = data;

  // Idempotency/race guard: if the tip already reached a terminal state (e.g.
  // cancelled, or already confirmed through a faster path) by the time this
  // runs, there is nothing left to verify.
  const currentTip = await paymentService.getTip(tipId);
  if (TERMINAL_TIP_STATUSES.includes(currentTip.status)) {
    logger.info(
      { tipId, status: currentTip.status },
      'Balance verification skipped: tip already in a terminal state'
    );
    return { tipId, skipped: true, status: currentTip.status };
  }

  const balances = await getWalletBalance(walletPublicKey);
  const rawBalance = assetCode === 'USDC' ? (balances.usdc ?? '0') : balances.lumens;
  const currentBalance = parseFloat(rawBalance);

  if (!Number.isFinite(currentBalance) || currentBalance < requiredAmount) {
    logger.warn(
      { tipId, walletPublicKey, requiredAmount, currentBalance, assetCode },
      'Balance verification failed: insufficient on-chain balance; marking tip FAILED'
    );
    await paymentService.updateTipStatus(tipId, { status: TipStatus.FAILED });
    return { tipId, sufficient: false, currentBalance, requiredAmount };
  }

  return { tipId, sufficient: true, currentBalance, requiredAmount };
}

export function createBalanceVerificationWorker(prisma: PrismaClient = new PrismaClient()) {
  const paymentService = new PaymentService(prisma);

  const worker = new Worker(
    QUEUE_NAMES.balanceVerification,
    withWorkerContext(async (job: Job) => {
      await job.updateProgress(10);
      const result = await verifyTipBalance(paymentService, job.data as BalanceVerificationJobData);
      await job.updateProgress(100);
      return result;
    }),
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: { backoffStrategy },
    }
  );

  worker.on('completed', (job) => {
    runWithJobContext(job, () => {
      logger.info({ jobId: job.id }, 'Balance verification worker completed job');
    });
  });

  worker.on('failed', async (job, error) => {
    if (!job) {
      logger.error('Balance verification worker failed job:', error);
      return;
    }
    await runWithJobContext(job, async () => {
      logger.error(
        { jobId: job.id, tipId: job.data?.tipId, error: error.message },
        'Balance verification worker failed job'
      );

      if (job.attemptsMade >= (job.opts.attempts ?? 5)) {
        const { tipId } = job.data as { tipId: string };
        try {
          // The balance could not be verified after every retry (persistent
          // Horizon outage, not a one-off blip). The tip cannot be left
          // PENDING forever, so it is marked FAILED like an insufficient
          // balance; the sender sees a clear failure rather than a tip stuck
          // pending with no path forward.
          await paymentService.updateTipStatus(tipId, { status: TipStatus.FAILED });
        } catch (updateError) {
          logger.error(
            { tipId, updateError },
            'Failed to mark tip FAILED after exhausted balance verification retries'
          );
        }

        await moveToDeadLetter(
          QUEUE_NAMES.balanceVerification,
          String(job.id),
          job.data,
          error.message
        );
      }
    });
  });

  return worker;
}
