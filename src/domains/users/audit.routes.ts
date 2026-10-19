import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../../services/audit.service';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { AppError } from '../../utils/errors';
import { registerAuditLog } from '../../plugins/auditLog';

/**
 * User activity audit log endpoints and logging hook (issue #215).
 *
 * Follows the same convention as `routes/metrics.routes.ts`'s
 * `registerMetricsRoute`: the routes-registration function also wires up
 * the related `onResponse` hook, since both the hook and the read
 * endpoints share one `AuditService` instance over the same `AuditLog`
 * table.
 */
export const registerAuditLogRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const auditService = new AuditService(prisma.auditLog as any);

  registerAuditLog(app, { auditService });

  // GET /api/v1/users/me/activity - the caller's own audit trail
  app.get<{ Querystring: { action?: string; from?: string; to?: string; limit?: string } }>(
    '/api/v1/users/me/activity',
    {
      preHandler: authMiddleware,
      schema: {
        description: "Fetch the authenticated user's own audit log entries.",
        querystring: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'Filter by exact action value' },
            from: {
              type: 'string',
              format: 'date-time',
              description: 'Inclusive lower bound on timestamp',
            },
            to: {
              type: 'string',
              format: 'date-time',
              description: 'Inclusive upper bound on timestamp',
            },
            limit: { type: 'string', description: 'Max rows to return (default 100, max 1000)' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true, description: 'Audit log entries' },
          401: { type: 'object', additionalProperties: true, description: 'Unauthorized' },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: { action?: string; from?: string; to?: string; limit?: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const { action, from, to, limit } = request.query;
        const entries = await auditService.query({
          userId: user.userId,
          action,
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
          limit: limit ? Number(limit) : undefined,
        });
        reply.send(formatSuccess(entries));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/admin/audit-log - admin investigation query across all users
  app.get<{
    Querystring: {
      userId?: string;
      resource?: string;
      resourceId?: string;
      action?: string;
      from?: string;
      to?: string;
      limit?: string;
    };
  }>(
    '/api/v1/admin/audit-log',
    {
      preHandler: [authMiddleware, requireAdmin],
      schema: {
        description:
          'Admin query over audit log entries, filterable by user, resource, action, and date range.',
        querystring: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            resource: { type: 'string' },
            resourceId: { type: 'string' },
            action: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            limit: { type: 'string' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true, description: 'Audit log entries' },
          401: { type: 'object', additionalProperties: true, description: 'Unauthorized' },
          403: { type: 'object', additionalProperties: true, description: 'Forbidden' },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: {
          userId?: string;
          resource?: string;
          resourceId?: string;
          action?: string;
          from?: string;
          to?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId, resource, resourceId, action, from, to, limit } = request.query;
        const entries = await auditService.query({
          userId,
          resource,
          resourceId,
          action,
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
          limit: limit ? Number(limit) : undefined,
        });
        reply.send(formatSuccess(entries));
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
