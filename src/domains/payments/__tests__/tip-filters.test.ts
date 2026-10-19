import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TIP_TEXT_SEARCH_MAX_LENGTH, buildTipWhere, describeTipFilters } from '../tip-filters';
import { TipHistoryQuerySchema } from '../payment.schemas';
import { PaymentService } from '../payment.service';

describe('buildTipWhere', () => {
  it('keeps the base scope and applies nothing when there are no filters', () => {
    expect(buildTipWhere({ creatorId: 'creator_1' })).toEqual({ creatorId: 'creator_1' });
    expect(buildTipWhere({ fromUserId: 'user_1' })).toEqual({ fromUserId: 'user_1' });
  });

  it('filters by status', () => {
    const where = buildTipWhere({ creatorId: 'creator_1' }, { status: 'completed' });
    expect(where.status).toBe('completed');
    expect(where.creatorId).toBe('creator_1');
  });

  it('builds an inclusive date range', () => {
    const where: any = buildTipWhere(
      {},
      { minDate: '2026-01-01T00:00:00.000Z', maxDate: '2026-02-01T00:00:00.000Z' }
    );
    expect(where.createdAt.gte).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(where.createdAt.lte).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('supports an open-ended date range on either side', () => {
    expect((buildTipWhere({}, { minDate: '2026-01-01T00:00:00.000Z' }) as any).createdAt).toEqual({
      gte: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect((buildTipWhere({}, { maxDate: '2026-01-01T00:00:00.000Z' }) as any).createdAt).toEqual({
      lte: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('resolves a bare, offset-less date against the given timezone (issue #216)', () => {
    const where: any = buildTipWhere(
      {},
      {
        minDate: '2026-01-15T00:00:00',
        maxDate: '2026-01-15T23:59:59',
        timezone: 'America/New_York',
      }
    );
    expect(where.createdAt.gte).toEqual(new Date('2026-01-15T05:00:00.000Z'));
    expect(where.createdAt.lte).toEqual(new Date('2026-01-16T04:59:59.000Z'));
  });

  it('ignores the timezone when minDate/maxDate already carry an explicit offset', () => {
    const where: any = buildTipWhere(
      {},
      { minDate: '2026-01-15T00:00:00Z', timezone: 'America/New_York' }
    );
    expect(where.createdAt.gte).toEqual(new Date('2026-01-15T00:00:00.000Z'));
  });

  it('defaults a bare date to UTC when no timezone is given', () => {
    const where: any = buildTipWhere({}, { minDate: '2026-01-15T00:00:00' });
    expect(where.createdAt.gte).toEqual(new Date('2026-01-15T00:00:00.000Z'));
  });

  it('builds an inclusive amount range, including a zero lower bound', () => {
    const where: any = buildTipWhere({}, { minAmount: 0, maxAmount: 500 });
    // `0` must not be dropped as falsy.
    expect(where.amount).toEqual({ gte: 0, lte: 500 });
  });

  it('filters by sender and creator', () => {
    const where = buildTipWhere({}, { fromUserId: 'user_1', creatorId: 'creator_1' });
    expect(where.fromUserId).toBe('user_1');
    expect(where.creatorId).toBe('creator_1');
  });

  it('searches the message case-insensitively and also matches id / tx hash', () => {
    const where: any = buildTipWhere({}, { query: 'thanks' });
    expect(where.AND).toHaveLength(1);
    expect(where.AND[0].OR).toEqual([
      { message: { contains: 'thanks', mode: 'insensitive' } },
      { id: { equals: 'thanks' } },
      { transactionHash: { equals: 'thanks' } },
    ]);
  });

  it('trims the search term and ignores a blank one', () => {
    expect((buildTipWhere({}, { query: '  coffee  ' }) as any).AND[0].OR[0]).toEqual({
      message: { contains: 'coffee', mode: 'insensitive' },
    });
    expect((buildTipWhere({}, { query: '   ' }) as any).AND).toBeUndefined();
  });

  it('combines every filter with AND', () => {
    const where: any = buildTipWhere(
      { creatorId: 'creator_1' },
      {
        status: 'pending',
        minDate: '2026-01-01T00:00:00.000Z',
        minAmount: 10,
        fromUserId: 'user_1',
        query: 'hi',
      }
    );

    expect(where.creatorId).toBe('creator_1');
    expect(where.status).toBe('pending');
    expect(where.fromUserId).toBe('user_1');
    expect(where.createdAt.gte).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(where.amount.gte).toBe(10);
    expect(where.AND[0].OR[0].message.contains).toBe('hi');
  });
});

describe('describeTipFilters', () => {
  it('echoes only the filters that were applied', () => {
    expect(describeTipFilters({})).toEqual({});
    expect(describeTipFilters({ status: 'failed', minAmount: 0 })).toEqual({
      status: 'failed',
      minAmount: 0,
    });
    expect(describeTipFilters({ query: '  hi  ' })).toEqual({ query: 'hi' });
  });
});

describe('TipHistoryQuerySchema', () => {
  it('accepts an empty query and leaves it empty', () => {
    expect(TipHistoryQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts bare dates without eagerly normalizing them, and coerces numeric strings', () => {
    // minDate/maxDate are deliberately kept as given, not normalized to a
    // UTC ISO string here (issue #216): resolveToUtc (buildTipWhere) is the
    // one place that decides what a bare, offset-less value means, once
    // `timezone` is also available. See the "timezone" describe block below.
    const parsed = TipHistoryQuerySchema.parse({
      minDate: '2026-01-01',
      maxDate: '2026-02-01',
      minAmount: '25',
      status: 'completed',
    });
    expect(parsed.minDate).toBe('2026-01-01');
    expect(parsed.maxDate).toBe('2026-02-01');
    expect(parsed.minAmount).toBe(25);
    expect(parsed.status).toBe('completed');
  });

  it('rejects an inverted date range', () => {
    const result = TipHistoryQuerySchema.safeParse({
      minDate: '2026-03-01T00:00:00.000Z',
      maxDate: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an inverted amount range and a negative amount', () => {
    expect(TipHistoryQuerySchema.safeParse({ minAmount: 500, maxAmount: 100 }).success).toBe(false);
    expect(TipHistoryQuerySchema.safeParse({ minAmount: -1 }).success).toBe(false);
  });

  it('rejects an unparseable date and an over-long search term', () => {
    expect(TipHistoryQuerySchema.safeParse({ minDate: 'not-a-date' }).success).toBe(false);
    expect(
      TipHistoryQuerySchema.safeParse({ query: 'x'.repeat(TIP_TEXT_SEARCH_MAX_LENGTH + 1) }).success
    ).toBe(false);
  });

  it('accepts a valid IANA timezone (issue #216)', () => {
    const parsed = TipHistoryQuerySchema.parse({ timezone: 'America/New_York' });
    expect(parsed.timezone).toBe('America/New_York');
  });

  it('rejects a timezone that is not a valid IANA identifier', () => {
    expect(TipHistoryQuerySchema.safeParse({ timezone: 'Not/AZone' }).success).toBe(false);
  });

  it('rejects an empty timezone', () => {
    expect(TipHistoryQuerySchema.safeParse({ timezone: '' }).success).toBe(false);
  });
});

const sampleTip = (i: number) => ({
  id: `tip_${i}`,
  fromUserId: 'user_1',
  creatorId: 'creator_1',
  amount: 10 * i,
  message: `Tip ${i}`,
  status: 'completed',
  transactionHash: `tx_${i}`,
  createdAt: new Date(1_700_000_000_000 - i * 60_000),
  updatedAt: new Date(1_700_000_000_000 - i * 60_000),
});

describe('PaymentService filtered listings', () => {
  const buildPrisma = () => {
    const tips = Array.from({ length: 5 }, (_, i) => sampleTip(i + 1));
    return {
      creator: { findUnique: vi.fn().mockResolvedValue({ id: 'creator_1' }) },
      tip: {
        findMany: vi.fn().mockResolvedValue(tips),
        count: vi.fn().mockResolvedValue(tips.length),
        findUnique: vi.fn(),
      },
    };
  };

  let paymentService: PaymentService;
  let prisma: ReturnType<typeof buildPrisma>;

  beforeEach(() => {
    prisma = buildPrisma();
    paymentService = new PaymentService(prisma as any);
  });

  it('pushes creator-listing filters into the database query and returns them', async () => {
    const result = await paymentService.listTips('creator_1', 1, 20, {
      status: 'completed',
      minAmount: 50,
      maxAmount: 500,
      minDate: '2026-01-01T00:00:00.000Z',
      query: 'thanks',
      fromUserId: 'user_1',
    });

    const where: any = prisma.tip.findMany.mock.calls[0][0].where;
    expect(where.creatorId).toBe('creator_1');
    expect(where.status).toBe('completed');
    expect(where.amount).toEqual({ gte: 50, lte: 500 });
    expect(where.createdAt.gte).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(where.fromUserId).toBe('user_1');
    expect(where.AND[0].OR[0].message.contains).toBe('thanks');

    // count() must see the same filter, otherwise the page metadata lies.
    expect(prisma.tip.count.mock.calls[0][0].where).toEqual(where);

    expect(result.filters).toMatchObject({
      status: 'completed',
      minAmount: 50,
      maxAmount: 500,
      query: 'thanks',
    });
  });

  it('scopes the user history to the caller and applies the amount band', async () => {
    await paymentService.getUserTipHistory('user_1', 1, 20, { minAmount: 100, status: 'pending' });

    const where: any = prisma.tip.findMany.mock.calls[0][0].where;
    expect(where.fromUserId).toBe('user_1');
    expect(where.amount).toEqual({ gte: 100 });
    expect(where.status).toBe('pending');
  });

  it('passes filters through the cursor listing as well', async () => {
    await paymentService.listTipsCursor('creator_1', { limit: 5, maxAmount: 40, query: 'coffee' });

    const where: any = prisma.tip.findMany.mock.calls[0][0].where;
    expect(where.creatorId).toBe('creator_1');
    expect(where.amount).toEqual({ lte: 40 });
    expect(where.AND[0].OR[0].message.contains).toBe('coffee');
  });

  it('searches across creators without adding an implicit scope', async () => {
    const result = await paymentService.searchTips(1, 20, {
      status: 'failed',
      minDate: '2026-01-01T00:00:00.000Z',
    });

    const where: any = prisma.tip.findMany.mock.calls[0][0].where;
    expect(where.creatorId).toBeUndefined();
    expect(where.fromUserId).toBeUndefined();
    expect(where.status).toBe('failed');
    expect(result.total).toBe(5);
    expect(result.filters).toMatchObject({ status: 'failed' });
  });

  it('formats response timestamps in the requested timezone (issue #216)', async () => {
    const result = await paymentService.listTips('creator_1', 1, 20, {
      timezone: 'America/New_York',
    });

    for (const tip of result.tips) {
      expect(tip.createdAt).toMatch(/[+-]\d{2}:\d{2}$/);
      expect(tip.createdAt).not.toMatch(/Z$/);
    }
  });

  it('formats response timestamps as plain UTC when no timezone is requested', async () => {
    const result = await paymentService.listTips('creator_1', 1, 20, {});

    for (const tip of result.tips) {
      expect(tip.createdAt).toMatch(/Z$/);
    }
  });

  it('echoes the requested timezone back in the filters metadata', async () => {
    const result = await paymentService.listTips('creator_1', 1, 20, {
      timezone: 'America/New_York',
    });
    expect(result.filters).toMatchObject({ timezone: 'America/New_York' });
  });
});
