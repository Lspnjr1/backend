/**
 * Scheduled creator payout routes (#222).
 *
 *   POST   /api/v1/creators/scheduled-payouts            create a recurring payout
 *   GET    /api/v1/creators/scheduled-payouts             list the caller's scheduled payouts
 *   GET    /api/v1/creators/scheduled-payouts/:id         read one
 *   POST   /api/v1/creators/scheduled-payouts/:id/pause   pause (stops triggering, keeps config)
 *   POST   /api/v1/creators/scheduled-payouts/:id/resume  resume a paused schedule
 *   POST   /api/v1/creators/scheduled-payouts/:id/cancel  cancel permanently
 *
 * The issue names `POST /api/creators/scheduled-payouts`; this repo's actual
 * convention (every other creator/payment route) is `/api/v1/...`, which is
 * what every route here follows instead.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { requireCreator } from '../../middleware/rbac';
import { formatSuccess, formatError } from '../../types/response';
import { AppError, UnauthorizedError } from '../../utils/errors';
import { ScheduledPayoutService } from './scheduled-payout.service';
import {
  CreateScheduledPayoutSchema,
  ScheduledPayoutIdParamsSchema,
  type CreateScheduledPayoutInput,
  type ScheduledPayoutIdParams,
} from './scheduled-payout.schemas';

export const registerScheduledPayoutRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const service = new ScheduledPayoutService(prisma);

  /** Resolves the Creator row for the authenticated user, or null if none. */
  const loadCreator = async (userId: string) =>
    prisma.creator.findUnique({ where: { userId }, select: { id: true } });

  const handleError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send(formatError(error.message, error.code, error.details));
      return;
    }
    throw error;
  };

  app.post<{ Body: CreateScheduledPayoutInput }>(
    '/api/v1/creators/scheduled-payouts',
    { preHandler: requireCreator },
    async (request: FastifyRequest<{ Body: CreateScheduledPayoutInput }>, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new UnauthorizedError('Authentication required');

        const creator = await loadCreator(user.userId);
        if (!creator) {
          reply.code(404).send(formatError('Creator profile not found', 'NOT_FOUND'));
          return;
        }

        const body = CreateScheduledPayoutSchema.parse(request.body);
        const result = await service.createScheduledPayout(creator.id, body);
        reply.code(201).send(formatSuccess(result));
      } catch (error) {
        if (error && typeof error === 'object' && 'issues' in error) {
          reply.code(400).send(
            formatError('The request data is invalid', 'VALIDATION_ERROR', {
              issues: (
                error as { issues: Array<{ path: (string | number)[]; message: string }> }
              ).issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
            })
          );
          return;
        }
        handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/creators/scheduled-payouts',
    { preHandler: requireCreator },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new UnauthorizedError('Authentication required');

        const creator = await loadCreator(user.userId);
        if (!creator) {
          reply.code(404).send(formatError('Creator profile not found', 'NOT_FOUND'));
          return;
        }

        const result = await service.listScheduledPayouts(creator.id);
        reply.send(formatSuccess({ scheduledPayouts: result }));
      } catch (error) {
        handleError(reply, error);
      }
    }
  );

  app.get<{ Params: ScheduledPayoutIdParams }>(
    '/api/v1/creators/scheduled-payouts/:id',
    { preHandler: requireCreator },
    async (request: FastifyRequest<{ Params: ScheduledPayoutIdParams }>, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new UnauthorizedError('Authentication required');

        const creator = await loadCreator(user.userId);
        if (!creator) {
          reply.code(404).send(formatError('Creator profile not found', 'NOT_FOUND'));
          return;
        }

        const { id } = ScheduledPayoutIdParamsSchema.parse(request.params);
        const result = await service.getScheduledPayout(creator.id, id);
        reply.send(formatSuccess(result));
      } catch (error) {
        handleError(reply, error);
      }
    }
  );

  const transitionHandler =
    (action: (creatorId: string, id: string) => Promise<unknown>) =>
    async (request: FastifyRequest<{ Params: ScheduledPayoutIdParams }>, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new UnauthorizedError('Authentication required');

        const creator = await loadCreator(user.userId);
        if (!creator) {
          reply.code(404).send(formatError('Creator profile not found', 'NOT_FOUND'));
          return;
        }

        const { id } = ScheduledPayoutIdParamsSchema.parse(request.params);
        const result = await action(creator.id, id);
        reply.send(formatSuccess(result));
      } catch (error) {
        handleError(reply, error);
      }
    };

  app.post<{ Params: ScheduledPayoutIdParams }>(
    '/api/v1/creators/scheduled-payouts/:id/pause',
    { preHandler: requireCreator },
    transitionHandler((creatorId, id) => service.pauseScheduledPayout(creatorId, id))
  );

  app.post<{ Params: ScheduledPayoutIdParams }>(
    '/api/v1/creators/scheduled-payouts/:id/resume',
    { preHandler: requireCreator },
    transitionHandler((creatorId, id) => service.resumeScheduledPayout(creatorId, id))
  );

  app.post<{ Params: ScheduledPayoutIdParams }>(
    '/api/v1/creators/scheduled-payouts/:id/cancel',
    { preHandler: requireCreator },
    transitionHandler((creatorId, id) => service.cancelScheduledPayout(creatorId, id))
  );
};
