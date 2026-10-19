import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CreatorExportService } from '../export.service';
import { NotFoundError } from '../../../utils/errors';

function makeTip(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    amount: 100,
    assetCode: 'USDC',
    status: 'completed',
    ...overrides,
  };
}

describe('CreatorExportService', () => {
  let prisma: {
    creator: { findUnique: ReturnType<typeof vi.fn> };
    tip: { findMany: ReturnType<typeof vi.fn> };
    stellarAsset: { findMany: ReturnType<typeof vi.fn> };
  };
  let service: CreatorExportService;

  beforeEach(() => {
    prisma = {
      creator: { findUnique: vi.fn() },
      tip: { findMany: vi.fn() },
      stellarAsset: { findMany: vi.fn() },
    };
    service = new CreatorExportService(prisma as any);
  });

  it('throws NotFoundError for an unknown creator', async () => {
    prisma.creator.findUnique.mockResolvedValue(null);
    await expect(service.exportTransactions('missing', 'csv')).rejects.toThrow(NotFoundError);
  });

  it('exports an empty CSV with just headers when there are no tips', async () => {
    prisma.creator.findUnique.mockResolvedValue({ id: 'creator-1', username: 'alice' });
    prisma.tip.findMany.mockResolvedValue([]);
    prisma.stellarAsset.findMany.mockResolvedValue([]);

    const result = await service.exportTransactions('creator-1', 'csv');

    expect(result.contentType).toBe('text/csv; charset=utf-8');
    expect(result.filename).toMatch(/^alice-transactions-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(result.content).toBe('date,amount,asset,status,fee\n');
  });

  it('includes a row per tip with the computed fee', async () => {
    prisma.creator.findUnique.mockResolvedValue({ id: 'creator-1', username: 'alice' });
    prisma.tip.findMany.mockResolvedValue([makeTip({ amount: 100 })]);
    prisma.stellarAsset.findMany.mockResolvedValue([{ code: 'USDC', feeBps: 250 }]);

    const result = await service.exportTransactions('creator-1', 'csv');

    expect(result.content).toContain('"2026-01-15T10:00:00.000Z","100","USDC","completed","2.5"');
  });

  it('reports a zero fee for an asset with no configured feeBps', async () => {
    prisma.creator.findUnique.mockResolvedValue({ id: 'creator-1', username: 'alice' });
    prisma.tip.findMany.mockResolvedValue([makeTip({ amount: 50, assetCode: 'XLM' })]);
    prisma.stellarAsset.findMany.mockResolvedValue([]);

    const result = await service.exportTransactions('creator-1', 'csv');

    expect(result.content).toContain('"XLM","completed","0"');
  });

  it('passes date/asset/status filters through to the tip query', async () => {
    prisma.creator.findUnique.mockResolvedValue({ id: 'creator-1', username: 'alice' });
    prisma.tip.findMany.mockResolvedValue([]);
    prisma.stellarAsset.findMany.mockResolvedValue([]);

    await service.exportTransactions('creator-1', 'csv', {
      minDate: '2026-01-01T00:00:00.000Z',
      maxDate: '2026-02-01T00:00:00.000Z',
      assetCode: 'USDC',
      status: 'completed',
    });

    const where = prisma.tip.findMany.mock.calls[0][0].where;
    expect(where.creatorId).toBe('creator-1');
    expect(where.assetCode).toBe('USDC');
    expect(where.status).toBe('completed');
    expect(where.createdAt).toEqual({
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lte: new Date('2026-02-01T00:00:00.000Z'),
    });
  });

  it('excludes hidden/removed tips via the moderation state scope', async () => {
    prisma.creator.findUnique.mockResolvedValue({ id: 'creator-1', username: 'alice' });
    prisma.tip.findMany.mockResolvedValue([]);
    prisma.stellarAsset.findMany.mockResolvedValue([]);

    await service.exportTransactions('creator-1', 'csv');

    const where = prisma.tip.findMany.mock.calls[0][0].where;
    expect(where.moderationState).toBe('visible');
  });

  it('generates a non-empty PDF buffer', async () => {
    prisma.creator.findUnique.mockResolvedValue({ id: 'creator-1', username: 'alice' });
    prisma.tip.findMany.mockResolvedValue([makeTip()]);
    prisma.stellarAsset.findMany.mockResolvedValue([{ code: 'USDC', feeBps: 100 }]);

    const result = await service.exportTransactions('creator-1', 'pdf');

    expect(result.contentType).toBe('application/pdf');
    expect(result.filename).toMatch(/\.pdf$/);
    expect(Buffer.isBuffer(result.content)).toBe(true);
    expect((result.content as Buffer).length).toBeGreaterThan(0);
    // PDF magic bytes.
    expect((result.content as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('generates a PDF with no rows without throwing', async () => {
    prisma.creator.findUnique.mockResolvedValue({ id: 'creator-1', username: 'alice' });
    prisma.tip.findMany.mockResolvedValue([]);
    prisma.stellarAsset.findMany.mockResolvedValue([]);

    const result = await service.exportTransactions('creator-1', 'pdf');

    expect((result.content as Buffer).length).toBeGreaterThan(0);
  });
});
