import type { PrismaClient } from '@prisma/client';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerCreatorExportRoutes } from '../export.routes';

const { exportTransactionsMock } = vi.hoisted(() => ({ exportTransactionsMock: vi.fn() }));
vi.mock('../export.service', () => ({
  CreatorExportService: vi.fn(() => ({ exportTransactions: exportTransactionsMock })),
}));
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' });
    request.user = { userId: 'user-1', email: 'user@example.com', role: 'creator' };
  },
}));

const app = Fastify();
const prisma = { creator: { findUnique: vi.fn().mockResolvedValue({ id: 'creator-1' }) } };
registerCreatorExportRoutes(app, prisma as unknown as PrismaClient);

afterEach(() => {
  vi.clearAllMocks();
});

it('requires authentication', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/creators/me/export/transactions',
  });
  expect(response.statusCode).toBe(401);
  expect(exportTransactionsMock).not.toHaveBeenCalled();
});

it('returns 404 when the caller has no creator profile', async () => {
  prisma.creator.findUnique.mockResolvedValueOnce(null);
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/creators/me/export/transactions',
    headers: { authorization: 'Bearer token' },
  });
  expect(response.statusCode).toBe(404);
  expect(exportTransactionsMock).not.toHaveBeenCalled();
});

it('exports CSV by default with the correct headers', async () => {
  exportTransactionsMock.mockResolvedValue({
    content: 'date,amount\n',
    contentType: 'text/csv; charset=utf-8',
    filename: 'alice-transactions-2026-01-01.csv',
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/creators/me/export/transactions',
    headers: { authorization: 'Bearer token' },
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/csv');
  expect(response.headers['content-disposition']).toBe(
    'attachment; filename="alice-transactions-2026-01-01.csv"'
  );
  expect(exportTransactionsMock).toHaveBeenCalledWith('creator-1', 'csv', {
    minDate: undefined,
    maxDate: undefined,
    assetCode: undefined,
    status: undefined,
  });
});

it('exports PDF when format=pdf is requested', async () => {
  exportTransactionsMock.mockResolvedValue({
    content: Buffer.from('%PDF-1.4'),
    contentType: 'application/pdf',
    filename: 'alice-transactions-2026-01-01.pdf',
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/creators/me/export/transactions?format=pdf',
    headers: { authorization: 'Bearer token' },
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('application/pdf');
  expect(exportTransactionsMock).toHaveBeenCalledWith('creator-1', 'pdf', expect.anything());
});

it('forwards date/asset/status filters', async () => {
  exportTransactionsMock.mockResolvedValue({
    content: '',
    contentType: 'text/csv; charset=utf-8',
    filename: 'x.csv',
  });

  await app.inject({
    method: 'GET',
    url: '/api/v1/creators/me/export/transactions?minDate=2026-01-01&maxDate=2026-02-01&assetCode=USDC&status=completed',
    headers: { authorization: 'Bearer token' },
  });

  expect(exportTransactionsMock).toHaveBeenCalledWith('creator-1', 'csv', {
    minDate: '2026-01-01',
    maxDate: '2026-02-01',
    assetCode: 'USDC',
    status: 'completed',
  });
});
