import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ApiKeyService, CreateApiKeyRequest } from './api-key.service';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { ValidationError, AppError } from '../../utils/errors';

export const registerDeveloperKeyRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const apiKeyService = new ApiKeyService(prisma);

  // POST /api/developers/keys - Create a developer API key
  app.post<{ Body: CreateApiKeyRequest }>(
    '/api/developers/keys',
    {
      preHandler: authMiddleware,
      schema: {
        description:
          'Create a developer API key for service-to-service calls. The raw key is returned once, in this response, and never again.',
        body: {
          type: 'object',
          required: ['name', 'permissions'],
          properties: {
            name: { type: 'string', description: 'Human-readable label for this key' },
            permissions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Permission scopes this key is allowed to act under',
            },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: 'Optional ISO-8601 expiry; omit for a non-expiring key',
            },
          },
        },
        response: {
          201: { type: 'object', additionalProperties: true, description: 'API key created' },
          400: { type: 'object', additionalProperties: true, description: 'Validation error' },
          401: { type: 'object', additionalProperties: true, description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const body = request.body as CreateApiKeyRequest;
        const result = await apiKeyService.createKey(user.userId, body);
        reply.code(201).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(400).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/developers/keys - List the caller's developer API keys
  app.get(
    '/api/developers/keys',
    {
      preHandler: authMiddleware,
      schema: {
        description:
          "List developer API keys owned by the authenticated user. Raw key values are never returned here, only each key's prefix.",
        response: {
          200: { type: 'object', additionalProperties: true, description: 'List of API keys' },
          401: { type: 'object', additionalProperties: true, description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const result = await apiKeyService.listKeys(user.userId);
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

  // DELETE /api/developers/keys/:keyId - Revoke a developer API key
  app.delete<{ Params: { keyId: string } }>(
    '/api/developers/keys/:keyId',
    {
      preHandler: authMiddleware,
      schema: {
        description: 'Revoke a developer API key. Revocation is immediate and irreversible.',
        params: {
          type: 'object',
          properties: {
            keyId: { type: 'string', description: 'API key ID' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true, description: 'API key revoked' },
          401: { type: 'object', additionalProperties: true, description: 'Unauthorized' },
          404: { type: 'object', additionalProperties: true, description: 'API key not found' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const { keyId } = request.params as { keyId: string };
        const result = await apiKeyService.revokeKey(user.userId, keyId);
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
