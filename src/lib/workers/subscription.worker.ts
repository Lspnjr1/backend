import { Queue, Worker } from 'bullmq';
import { chargeDueSubscriptions } from '../../domains/subscriptions/subscription.charge';
import { withJobTracePayload, withWorkerContext, runWithJobContext } from '../requestContext';

const QUEUE_NAME = 'subscription-billing';

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null as null,
};

export async function startSubscriptionWorker() {
  const queue = new Queue(QUEUE_NAME, { connection });

  // Runs every 5 minutes; jobId keeps it from being registered twice
  await queue.add(
    'charge-due',
    withJobTracePayload({}),
    { repeat: { every: 5 * 60 * 1000 }, jobId: 'charge-due-subscriptions' },
  );

  const worker = new Worker(
    QUEUE_NAME,
    withWorkerContext(async () => {
      const count = await chargeDueSubscriptions();
      return { processed: count };
    }),
    { connection },
  );

  worker.on('failed', (job, err) => {
    if (job) {
      runWithJobContext(job, () => {
        console.error('[subscription-worker] job failed', job?.id, err);
      });
    } else {
      console.error('[subscription-worker] job failed', err);
    }
  });

  return worker;
}