import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { formatError, formatSuccess } from '../../types/response';
import { AppError } from '../../utils/errors';
import { PrivacyService } from './privacy.service';

type ExportRow = { id: string; createdAt: string; email?: string | null; name?: string | null };

function csv(rows: ExportRow[]): string {
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return (
    [
      ['id', 'created_at', 'email', 'name'],
      ...rows.map((row) => [row.id, row.createdAt, row.email, row.name]),
    ]
      .map((row) => row.map(escape).join(','))
      .join('\n') + '\n'
  );
}

const RequestDeletionSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

const CancelDeletionSchema = z.object({
  token: z.string().trim().min(1, 'Cancellation token is required'),
});

export function registerPrivacyRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const privacyService = new PrivacyService(prisma);

  /**
   * Legacy synchronous export, kept for existing consumers that read JSON or
   * CSV directly in the response. New integrations should use the ZIP export
   * below (#220).
   */
  app.get<{ Querystring: { format?: 'json' | 'csv' } }>(
    '/api/v1/privacy/export',
    { preHandler: authMiddleware },
    async (
      request: FastifyRequest<{ Querystring: { format?: 'json' | 'csv' } }>,
      reply: FastifyReply
    ) => {
      if (!request.user) return reply.code(401).send(formatError('Unauthorized', 'UNAUTHORIZED'));
      const user = await prisma.user.findUnique({
        where: { id: request.user.userId },
        include: { wallets: true, creator: true, tips: true, payments: true },
      });
      if (!user) return reply.code(404).send(formatError('User not found', 'USER_NOT_FOUND'));
      const data = {
        exportedAt: new Date().toISOString(),
        user,
        wallets: user.wallets,
        tips: user.tips,
        payments: user.payments,
      };
      if (request.query.format === 'csv') {
        const rows = [
          {
            id: user.id,
            createdAt: user.createdAt.toISOString(),
            email: user.email,
            name: user.name,
          },
          ...user.tips.map((tip) => ({
            id: tip.id,
            createdAt: tip.createdAt.toISOString(),
            email: null,
            name: `tip:${tip.status}`,
          })),
        ];
        return reply
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="dorisio-data-export.csv"')
          .send(csv(rows));
      }
      return reply.send(formatSuccess(data));
    }
  );

  /**
   * POST /api/v1/privacy/export
   * Full GDPR data export as a downloadable ZIP archive (#220).
   */
  app.post(
    '/api/v1/privacy/export',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send(formatError('Unauthorized', 'UNAUTHORIZED'));
      try {
        const result = await privacyService.exportUserDataAsZip(request.user.userId);
        return reply
          .type('application/zip')
          .header('Content-Disposition', `attachment; filename="${result.filename}"`)
          .send(result.buffer);
      } catch (error) {
        if (error instanceof AppError) {
          return reply.code(error.statusCode).send(formatError(error.message, error.code));
        }
        throw error;
      }
    }
  );

  /**
   * POST /api/v1/privacy/delete-account
   * Requests account deletion (#220). Requires the caller's current password.
   * Deletion is queued for DELETION_GRACE_PERIOD_DAYS (30 days) rather than
   * immediate, and a cancellation link is emailed to the account.
   */
  app.post<{ Body: unknown }>(
    '/api/v1/privacy/delete-account',
    { preHandler: authMiddleware },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send(formatError('Unauthorized', 'UNAUTHORIZED'));
      try {
        const body = RequestDeletionSchema.parse(request.body);
        const scheduled = await privacyService.requestDeletion(request.user.userId, body.password);
        return reply.code(202).send(formatSuccess(scheduled));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send(
            formatError('The request data is invalid', 'VALIDATION_ERROR', {
              issues: error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            })
          );
        }
        if (error instanceof AppError) {
          return reply.code(error.statusCode).send(formatError(error.message, error.code));
        }
        throw error;
      }
    }
  );

  /**
   * GET /api/v1/privacy/delete-account
   * Current pending deletion request for the caller, if any.
   */
  app.get(
    '/api/v1/privacy/delete-account',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send(formatError('Unauthorized', 'UNAUTHORIZED'));
      const scheduled = await privacyService.getPendingDeletion(request.user.userId);
      return reply.send(formatSuccess({ scheduledDeletion: scheduled }));
    }
  );

  /**
   * POST /api/v1/privacy/delete-account/cancel
   * Cancels a pending deletion using the token from the confirmation email's
   * cancellation link. Unauthenticated by design: the email recipient may not
   * be signed in (or may want to cancel from a different device), and the
   * single-use hashed token is the credential.
   */
  app.post<{ Body: unknown }>(
    '/api/v1/privacy/delete-account/cancel',
    {},
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      try {
        const body = CancelDeletionSchema.parse(request.body);
        const cancelled = await privacyService.cancelDeletionByToken(body.token);
        return reply.send(formatSuccess(cancelled));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send(
            formatError('The request data is invalid', 'VALIDATION_ERROR', {
              issues: error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            })
          );
        }
        if (error instanceof AppError) {
          return reply.code(error.statusCode).send(formatError(error.message, error.code));
        }
        throw error;
      }
    }
  );
}
