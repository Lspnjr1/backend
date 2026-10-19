import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { CreatorExportService, TransactionExportFormat } from './export.service';
import { formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { AppError } from '../../utils/errors';

interface ExportQuery {
  format?: TransactionExportFormat;
  minDate?: string;
  maxDate?: string;
  assetCode?: string;
  status?: string;
}

/**
 * Creator financial data export endpoint (issue #219).
 */
export const registerCreatorExportRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const exportService = new CreatorExportService(prisma);

  app.get<{ Querystring: ExportQuery }>(
    '/api/v1/creators/me/export/transactions',
    {
      preHandler: authMiddleware,
      schema: {
        description:
          "Export the authenticated creator's own transaction history as CSV or PDF, filterable by date range, asset, and status.",
        querystring: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['csv', 'pdf'],
              description: 'Export format (default csv)',
            },
            minDate: { type: 'string', description: 'Inclusive lower bound on tip createdAt' },
            maxDate: { type: 'string', description: 'Inclusive upper bound on tip createdAt' },
            assetCode: { type: 'string', description: 'Restrict to this asset (e.g. "USDC")' },
            status: { type: 'string', description: 'Restrict to this tip status' },
          },
        },
        response: {
          401: { type: 'object', additionalProperties: true, description: 'Unauthorized' },
          404: { type: 'object', additionalProperties: true, description: 'Creator not found' },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: ExportQuery }>, reply: FastifyReply) => {
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

        const { format = 'csv', minDate, maxDate, assetCode, status } = request.query;
        const result = await exportService.exportTransactions(creator.id, format, {
          minDate,
          maxDate,
          assetCode,
          status,
        });

        reply
          .type(result.contentType)
          .header('Content-Disposition', `attachment; filename="${result.filename}"`)
          .send(result.content);
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
