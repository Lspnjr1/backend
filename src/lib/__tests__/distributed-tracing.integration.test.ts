import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runWithRequestContext,
  getRequestId,
  getRequestContext,
  withJobTracePayload,
  extractJobTrace,
  withWorkerContext,
  runWithJobContext,
} from '../requestContext';
import { logger } from '../../utils/logger';
import {
  enqueueEmail,
  enqueueImageProcessing,
  enqueueAnalytics,
  enqueueExport,
  enqueueStellarConfirmation,
  enqueueWebhookDispatch,
} from '../jobs/enqueue';
import { enqueueMediaProcessing } from '../../domains/media/media.queue';
import { enqueueEmail as enqueueNotificationEmail } from '../../domains/notifications/email';
import { BullJobQueue } from '../jobs/bull-queue';
import { InMemoryJobQueue } from '../jobs/memory-queue';
import { QueryLogger } from '../../db/query-logger';

// Mock Queues
vi.mock('../queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../queue')>();
  return {
    ...actual,
    stellarConfirmationQueue: { add: vi.fn().mockImplementation((name, data) => Promise.resolve({ id: 'stellar-job-1', data })) },
    webhookDispatchQueue: { add: vi.fn().mockImplementation((name, data) => Promise.resolve({ id: 'webhook-job-1', data })) },
    emailQueue: { add: vi.fn().mockImplementation((name, data) => Promise.resolve({ id: 'email-job-1', data })) },
    imageProcessingQueue: { add: vi.fn().mockImplementation((name, data) => Promise.resolve({ id: 'image-job-1', data })) },
    analyticsQueue: { add: vi.fn().mockImplementation((name, data) => Promise.resolve({ id: 'analytics-job-1', data })) },
    exportsQueue: { add: vi.fn().mockImplementation((name, data) => Promise.resolve({ id: 'exports-job-1', data })) },
    emailNotificationQueue: {
      add: vi.fn().mockImplementation((name, data) => Promise.resolve({ id: 'email-notif-job-1', data })),
      addBulk: vi.fn().mockImplementation((jobs: any[]) => Promise.resolve(jobs.map((j: any, i: number) => ({ id: `batch-${i}`, data: j.data })))),
    },
  };
});

describe('Distributed Request Context & Tracing Propagation (#184)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. All async jobs carry request ID and trace context in their payload', () => {
    it('enqueues stellar confirmation with originating request ID and user ID', async () => {
      const { stellarConfirmationQueue } = await import('../queue');

      await runWithRequestContext({ requestId: 'req-origin-1', userId: 'user-sender-1' }, async () => {
        await enqueueStellarConfirmation({
          tipId: 'tip-123',
          transactionHash: 'hash-abc',
        });
      });

      expect(stellarConfirmationQueue.add).toHaveBeenCalledWith(
        'confirm-stellar',
        expect.objectContaining({
          tipId: 'tip-123',
          transactionHash: 'hash-abc',
          requestId: 'req-origin-1',
          userId: 'user-sender-1',
          traceContext: expect.objectContaining({
            requestId: 'req-origin-1',
            userId: 'user-sender-1',
          }),
        }),
        expect.anything()
      );
    });

    it('enqueues webhook dispatch with originating trace context', async () => {
      const { webhookDispatchQueue } = await import('../queue');

      await runWithRequestContext({ requestId: 'req-origin-webhook', userId: 'creator-9' }, async () => {
        await enqueueWebhookDispatch({
          webhookId: 'wh-1',
          eventType: 'payment.completed',
          payload: { amount: 50 },
        });
      });

      expect(webhookDispatchQueue.add).toHaveBeenCalledWith(
        'dispatch-webhook',
        expect.objectContaining({
          webhookId: 'wh-1',
          eventType: 'payment.completed',
          requestId: 'req-origin-webhook',
          userId: 'creator-9',
          traceContext: expect.objectContaining({
            requestId: 'req-origin-webhook',
            userId: 'creator-9',
          }),
        }),
        expect.anything()
      );
    });

    it('enqueues email, analytics, exports, and image processing with trace context', async () => {
      const { emailQueue, analyticsQueue, exportsQueue, imageProcessingQueue } = await import('../queue');

      await runWithRequestContext({ requestId: 'req-multi-jobs', userId: 'user-multi' }, async () => {
        await enqueueEmail({ to: 'user@example.com', subject: 'Receipt', body: 'Thank you' });
        await enqueueAnalytics({ creatorId: 'cr-1', rangeDays: 30 });
        await enqueueExport({ userId: 'user-multi', type: 'tips' });
        await enqueueImageProcessing({ assetUrl: 'https://cdn.example.com/img.jpg', operations: ['thumb'] });
        await enqueueMediaProcessing('media-777');
      });

      expect(emailQueue.add).toHaveBeenCalledWith(
        'send-email',
        expect.objectContaining({ requestId: 'req-multi-jobs', userId: 'user-multi' }),
        expect.anything()
      );
      expect(analyticsQueue.add).toHaveBeenCalledWith(
        'compute-analytics',
        expect.objectContaining({ requestId: 'req-multi-jobs', userId: 'user-multi' }),
        expect.anything()
      );
      expect(exportsQueue.add).toHaveBeenCalledWith(
        'generate-export',
        expect.objectContaining({ requestId: 'req-multi-jobs', userId: 'user-multi' }),
        expect.anything()
      );
      expect(imageProcessingQueue.add).toHaveBeenCalledWith(
        'process-image',
        expect.objectContaining({ requestId: 'req-multi-jobs', userId: 'user-multi' }),
        expect.anything()
      );
      expect(imageProcessingQueue.add).toHaveBeenCalledWith(
        'process-media',
        expect.objectContaining({ mediaId: 'media-777', requestId: 'req-multi-jobs' }),
        expect.anything()
      );
    });

    it('enqueues notification emails with trace context', async () => {
      const { emailNotificationQueue } = await import('../queue');

      await runWithRequestContext({ requestId: 'req-email-notif', userId: 'user-email-target' }, async () => {
        await enqueueNotificationEmail({
          to: 'client@example.com',
          template: 'password-reset',
          data: { name: 'Alice' },
          userId: 'user-email-target',
        });
      });

      expect(emailNotificationQueue.add).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({
          to: 'client@example.com',
          template: 'password-reset',
          requestId: 'req-email-notif',
          userId: 'user-email-target',
        }),
        expect.anything()
      );
    });

    it('InMemoryJobQueue enriches enqueued records with trace context', async () => {
      const memQueue = new InMemoryJobQueue('test-in-mem');

      await runWithRequestContext({ requestId: 'req-mem-queue', userId: 'user-mem' }, async () => {
        const record = await memQueue.enqueue('task-1', { custom: 123 });
        expect(record.data).toEqual(
          expect.objectContaining({
            custom: 123,
            requestId: 'req-mem-queue',
            userId: 'user-mem',
            traceContext: expect.objectContaining({
              requestId: 'req-mem-queue',
              userId: 'user-mem',
            }),
          })
        );
      });
    });
  });

  describe('2. Worker logs include originating request ID via context middleware', () => {
    it('restores context inside worker processor and reflects in logger.info mixin', async () => {
      let loggedRequestId: string | undefined;
      let loggedUserId: string | undefined;

      const infoSpy = vi.spyOn(logger, 'info').mockImplementation((...args: any[]) => {
        const ctx = getRequestContext();
        loggedRequestId = ctx?.requestId;
        loggedUserId = ctx?.userId;
      });

      const workerProcessor = withWorkerContext(async (job: any) => {
        logger.info({ tipId: job.data.tipId }, 'Worker processing transaction');
        return { success: true };
      });

      const mockJob = {
        id: 'job-999',
        name: 'confirm-stellar',
        data: {
          tipId: 'tip-999',
          requestId: 'req-trace-xyz-789',
          userId: 'user-origin-sender',
        },
      };

      await workerProcessor(mockJob);

      expect(infoSpy).toHaveBeenCalled();
      expect(loggedRequestId).toBe('req-trace-xyz-789');
      expect(loggedUserId).toBe('user-origin-sender');

      infoSpy.mockRestore();
    });

    it('falls back to deterministic correlation ID for unsourced cron jobs', async () => {
      let loggedRequestId: string | undefined;

      const workerProcessor = withWorkerContext(async (job: any) => {
        loggedRequestId = getRequestId();
        return { ok: true };
      });

      const cronJob = {
        id: 'cron-hourly-1',
        name: 'analytics.aggregate',
        data: {},
      };

      await workerProcessor(cronJob);

      expect(loggedRequestId).toBe('job-analytics.aggregate-cron-hourly-1');
    });
  });

  describe('3. Chained Payment Confirmation -> Webhook correlation', () => {
    it('propagates the originating tip creation request ID through worker to downstream webhook dispatch', async () => {
      const { webhookDispatchQueue } = await import('../queue');

      const initialRequestId = 'req-initial-tip-creation-uuid-42';
      const initialUserId = 'user-patron-101';

      // Step A: Client requests tip creation / confirmation
      const jobPayload = withJobTracePayload(
        {
          tipId: 'tip-stellar-55',
          transactionHash: 'hash-stellar-999',
        },
        { requestId: initialRequestId, userId: initialUserId }
      );

      expect(jobPayload.requestId).toBe(initialRequestId);
      expect(jobPayload.userId).toBe(initialUserId);

      // Step B: Worker picks up Stellar confirmation job
      const stellarWorkerProcessor = withWorkerContext(async (job: any) => {
        // Confirm worker has restored context
        expect(getRequestId()).toBe(initialRequestId);

        // Worker simulates confirming transaction and updating status,
        // which triggers webhook dispatch:
        await enqueueWebhookDispatch({
          webhookId: 'wh-merchant-1',
          eventType: 'payment.completed',
          payload: {
            tipId: job.data.tipId,
            status: 'completed',
          },
        });

        return { confirmed: true };
      });

      await stellarWorkerProcessor({
        id: 'stellar-job-confirm',
        name: 'confirm-transaction',
        data: jobPayload,
      });

      // Step C: Verify webhook dispatch received the SAME originating request ID
      expect(webhookDispatchQueue.add).toHaveBeenCalledWith(
        'dispatch-webhook',
        expect.objectContaining({
          eventType: 'payment.completed',
          requestId: initialRequestId,
          userId: initialUserId,
          traceContext: expect.objectContaining({
            requestId: initialRequestId,
            userId: initialUserId,
          }),
        }),
        expect.anything()
      );
    });
  });

  describe('4. Database Query Logger correlation with request context', () => {
    it('query logger attaches current request ID to query logs', async () => {
      const queryLogger = new QueryLogger({ logQueries: true });
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      await runWithRequestContext({ requestId: 'req-db-trace-33' }, async () => {
        queryLogger.logQuery({
          queryName: 'findUniqueTip',
          sql: 'SELECT * FROM "Tip" WHERE id = ?',
          durationMs: 5,
        });
      });

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-db-trace-33',
          queryName: 'findUniqueTip',
        }),
        'Database query executed'
      );

      debugSpy.mockRestore();
    });
  });
});
