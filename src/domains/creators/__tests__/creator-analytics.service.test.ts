import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { CreatorAnalyticsService } from '../creator-analytics.service';
import { NotFoundError } from '../../../utils/errors';

let prisma: PrismaClient;
let service: CreatorAnalyticsService;
const createdUserIds: string[] = [];
let testCreatorId: string;
let testCreatorUserId: string;
const isDbAvailable = Boolean(process.env.DATABASE_URL);
let dbReachable = false;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe.skipIf(!isDbAvailable)('CreatorAnalyticsService (issue #217)', () => {
  beforeAll(async () => {
    if (!isDbAvailable) {
      console.warn('DATABASE_URL not set, skipping CreatorAnalyticsService tests');
      return;
    }
    try {
      prisma = new PrismaClient();
      await prisma.$queryRaw`SELECT 1`;
      dbReachable = true;
      service = new CreatorAnalyticsService(prisma);
    } catch {
      console.warn('Database connection failed, skipping CreatorAnalyticsService tests');
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    if (!dbReachable) {
      await prisma.$disconnect().catch(() => undefined);
      return;
    }
    try {
      await prisma.tip.deleteMany({ where: { creatorId: testCreatorId } });
      await prisma.creator.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.$disconnect();
    } catch {
      // ignore cleanup errors on disconnected DB
    }
  });

  beforeEach(async (ctx) => {
    if (!dbReachable || !prisma) {
      ctx.skip();
      return;
    }

    const creatorUser = await prisma.user.create({
      data: {
        email: `creator-analytics-${randomUUID()}@test.com`,
        password: 'hashed-password',
        name: 'Test Creator',
        role: 'creator',
      },
    });
    testCreatorUserId = creatorUser.id;
    createdUserIds.push(creatorUser.id);

    const creator = await prisma.creator.create({
      data: {
        userId: testCreatorUserId,
        username: `creator-${randomUUID()}`,
        displayName: 'Test Creator',
        isPublic: true,
        verified: true,
      },
    });
    testCreatorId = creator.id;
  });

  async function makeTip(opts: {
    fromUserId: string;
    amount: number;
    createdAt: Date;
    status?: string;
    moderationState?: string;
  }) {
    return prisma.tip.create({
      data: {
        fromUserId: opts.fromUserId,
        creatorId: testCreatorId,
        amount: opts.amount,
        status: opts.status ?? 'completed',
        moderationState: opts.moderationState ?? 'visible',
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
      },
    });
  }

  async function makeSupporter(name: string): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `supporter-${randomUUID()}@test.com`, password: 'hashed', name, role: 'fan' },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  it('throws NotFoundError for an unknown creator', async () => {
    await expect(service.getAnalytics('does-not-exist')).rejects.toThrow(NotFoundError);
  });

  it('returns zeroed totals when the creator has no tips', async () => {
    const result = await service.getAnalytics(testCreatorId);
    expect(result.totalTips).toBe(0);
    expect(result.totalAmount).toBe(0);
    expect(result.averageTipAmount).toBe(0);
    expect(result.topSupporters).toEqual([]);
  });

  it('computes total tips, total amount, and average tip amount', async () => {
    const alice = await makeSupporter('Alice');
    await makeTip({ fromUserId: alice, amount: 10, createdAt: daysAgo(1) });
    await makeTip({ fromUserId: alice, amount: 30, createdAt: daysAgo(1) });

    const result = await service.getAnalytics(testCreatorId);
    expect(result.totalTips).toBe(2);
    expect(result.totalAmount).toBe(40);
    expect(result.averageTipAmount).toBe(20);
  });

  it('excludes tips that are not completed', async () => {
    const alice = await makeSupporter('Alice');
    await makeTip({ fromUserId: alice, amount: 10, createdAt: daysAgo(1), status: 'pending' });
    await makeTip({ fromUserId: alice, amount: 20, createdAt: daysAgo(1), status: 'completed' });

    const result = await service.getAnalytics(testCreatorId);
    expect(result.totalTips).toBe(1);
    expect(result.totalAmount).toBe(20);
  });

  it('excludes tips that are hidden or removed by moderation', async () => {
    const alice = await makeSupporter('Alice');
    await makeTip({
      fromUserId: alice,
      amount: 10,
      createdAt: daysAgo(1),
      moderationState: 'hidden',
    });
    await makeTip({
      fromUserId: alice,
      amount: 20,
      createdAt: daysAgo(1),
      moderationState: 'visible',
    });

    const result = await service.getAnalytics(testCreatorId);
    expect(result.totalTips).toBe(1);
    expect(result.totalAmount).toBe(20);
  });

  it('ranks top supporters by total amount, not tip count', async () => {
    const alice = await makeSupporter('Alice');
    const bob = await makeSupporter('Bob');
    // Alice: 2 tips totalling 15; Bob: 1 tip totalling 100.
    await makeTip({ fromUserId: alice, amount: 10, createdAt: daysAgo(1) });
    await makeTip({ fromUserId: alice, amount: 5, createdAt: daysAgo(2) });
    await makeTip({ fromUserId: bob, amount: 100, createdAt: daysAgo(1) });

    const result = await service.getAnalytics(testCreatorId);
    expect(result.topSupporters[0]).toMatchObject({
      userId: bob,
      name: 'Bob',
      totalAmount: 100,
      tipCount: 1,
    });
    expect(result.topSupporters[1]).toMatchObject({
      userId: alice,
      name: 'Alice',
      totalAmount: 15,
      tipCount: 2,
    });
  });

  it('respects a custom topSupportersLimit', async () => {
    const alice = await makeSupporter('Alice');
    const bob = await makeSupporter('Bob');
    const carol = await makeSupporter('Carol');
    await makeTip({ fromUserId: alice, amount: 30, createdAt: daysAgo(1) });
    await makeTip({ fromUserId: bob, amount: 20, createdAt: daysAgo(1) });
    await makeTip({ fromUserId: carol, amount: 10, createdAt: daysAgo(1) });

    const result = await service.getAnalytics(testCreatorId, { topSupportersLimit: 2 });
    expect(result.topSupporters).toHaveLength(2);
  });

  it('caps topSupportersLimit at the maximum even if a larger value is requested', async () => {
    const alice = await makeSupporter('Alice');
    await makeTip({ fromUserId: alice, amount: 10, createdAt: daysAgo(1) });

    const result = await service.getAnalytics(testCreatorId, { topSupportersLimit: 10_000 });
    expect(result.topSupporters.length).toBeLessThanOrEqual(50);
  });

  it('filters by date range', async () => {
    const alice = await makeSupporter('Alice');
    await makeTip({ fromUserId: alice, amount: 10, createdAt: daysAgo(40) });
    await makeTip({ fromUserId: alice, amount: 20, createdAt: daysAgo(1) });

    const result = await service.getAnalytics(testCreatorId, {
      minDate: daysAgo(10).toISOString(),
    });
    expect(result.totalTips).toBe(1);
    expect(result.totalAmount).toBe(20);
  });

  it('buckets tips into daily, weekly, and monthly totals that each sum to the overall total', async () => {
    const alice = await makeSupporter('Alice');
    await makeTip({ fromUserId: alice, amount: 10, createdAt: daysAgo(1) });
    await makeTip({ fromUserId: alice, amount: 20, createdAt: daysAgo(10) });
    await makeTip({ fromUserId: alice, amount: 30, createdAt: daysAgo(40) });

    const result = await service.getAnalytics(testCreatorId);
    const sum = (buckets: { totalAmount: number }[]) =>
      buckets.reduce((acc, b) => acc + b.totalAmount, 0);

    expect(sum(result.daily)).toBe(60);
    expect(sum(result.weekly)).toBe(60);
    expect(sum(result.monthly)).toBe(60);
    // At least 2 distinct months given a 40-day spread.
    expect(result.monthly.length).toBeGreaterThanOrEqual(2);
  });

  it('returns results sorted ascending by period label', async () => {
    const alice = await makeSupporter('Alice');
    await makeTip({ fromUserId: alice, amount: 10, createdAt: daysAgo(1) });
    await makeTip({ fromUserId: alice, amount: 20, createdAt: daysAgo(40) });

    const result = await service.getAnalytics(testCreatorId);
    const periods = result.monthly.map((b) => b.period);
    const sorted = [...periods].sort();
    expect(periods).toEqual(sorted);
  });

  it('caches the result for repeated identical filter requests', async () => {
    const alice = await makeSupporter('Alice');
    await makeTip({ fromUserId: alice, amount: 10, createdAt: daysAgo(1) });

    const first = await service.getAnalytics(testCreatorId);
    await makeTip({ fromUserId: alice, amount: 1000, createdAt: daysAgo(1) });
    const second = await service.getAnalytics(testCreatorId);

    // Second call should hit the cache and not reflect the new tip yet.
    expect(second.totalAmount).toBe(first.totalAmount);
  });
});
