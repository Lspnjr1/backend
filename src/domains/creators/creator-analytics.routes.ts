import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { CreatorAnalyticsService } from './creator-analytics.service';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { AppError } from '../../utils/errors';

/**
 * Payment analytics dashboard endpoint for a creator's own tips (issue #217).
 */
export const registerCreatorAnalyticsRoutes = (
  app: FastifyInstance,
  prisma: PrismaClient
): void => {
  const analyticsService = new CreatorAnalyticsService(prisma);

  app.get<{
    Querystring: {
      minDate?: string;
      maxDate?: string;
      timezone?: string;
      topSupportersLimit?: string;
    };
  }>(
    '/api/v1/creators/me/analytics',
    {
      preHandler: authMiddleware,
      schema: {
        description:
          'Payment analytics for the authenticated creator: total tips (daily/weekly/monthly), average tip amount, top supporters, and trend data. Cached for 1 hour per filter combination.',
        querystring: {
          type: 'object',
          properties: {
            minDate: { type: 'string', description: 'Inclusive lower bound on tip createdAt' },
            maxDate: { type: 'string', description: 'Inclusive upper bound on tip createdAt' },
            timezone: {
              type: 'string',
              description:
                'IANA timezone used to interpret minDate/maxDate and bucket day/week/month labels',
            },
            topSupportersLimit: {
              type: 'string',
              description: 'How many top supporters to return (default 10, max 50)',
            },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true, description: 'Analytics payload' },
          401: { type: 'object', additionalProperties: true, description: 'Unauthorized' },
          404: { type: 'object', additionalProperties: true, description: 'Creator not found' },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: {
          minDate?: string;
          maxDate?: string;
          timezone?: string;
          topSupportersLimit?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
          select: { id: true },
        });
        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const { minDate, maxDate, timezone, topSupportersLimit } = request.query;
        const result = await analyticsService.getAnalytics(creator.id, {
          minDate,
          maxDate,
          timezone,
          topSupportersLimit: topSupportersLimit ? Number(topSupportersLimit) : undefined,
        });
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );
};
