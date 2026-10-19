import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { NotFoundError } from '../../utils/errors';
import { getOrFetch, createCacheKey, CacheType } from '../../lib/cache/cache-aside';
import { resolveToUtc } from '../../utils/timezone';
import { TIP_VISIBLE_STATE } from '../moderation/moderation.types';

export interface CreatorAnalyticsFilters {
  /** Inclusive lower bound on `createdAt` (ISO-8601). */
  minDate?: string;
  /** Inclusive upper bound on `createdAt` (ISO-8601). */
  maxDate?: string;
  /** IANA timezone used to interpret minDate/maxDate and bucket day/week/month labels. */
  timezone?: string;
  /** How many top supporters to return. */
  topSupportersLimit?: number;
}

export interface PeriodBucket {
  /** Bucket start, formatted "YYYY-MM-DD" (day), ISO week (e.g. "2026-W03"), or "YYYY-MM" (month). */
  period: string;
  totalAmount: number;
  tipCount: number;
}

export interface TopSupporter {
  userId: string;
  name: string | null;
  totalAmount: number;
  tipCount: number;
}

export interface CreatorAnalytics {
  creatorId: string;
  totalTips: number;
  totalAmount: number;
  averageTipAmount: number;
  daily: PeriodBucket[];
  weekly: PeriodBucket[];
  monthly: PeriodBucket[];
  topSupporters: TopSupporter[];
  generatedAt: string;
}

/** Hard ceiling on the tip rows pulled into memory for one aggregation. */
const MAX_TIPS_PER_AGGREGATION = 50_000;

const DEFAULT_TOP_SUPPORTERS_LIMIT = 10;
const MAX_TOP_SUPPORTERS_LIMIT = 50;

function dayKey(date: Date, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthKey(date: Date, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  });
  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}`;
}

/**
 * ISO-8601 week label ("YYYY-Www") for `date`'s day-key in `timeZone`.
 *
 * Computed from the already-timezone-adjusted `YYYY-MM-DD` string (parsed
 * back as a UTC-anchored date purely to run the day-of-week/week-number
 * arithmetic), so the week boundary follows the requested timezone's
 * calendar day, not the server's.
 */
function weekKey(date: Date, timeZone?: string): string {
  const [year, month, day] = dayKey(date, timeZone).split('-').map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  // ISO week: Monday = 1 ... Sunday = 7. Shift to the Thursday of this
  // week, whose year always matches the ISO week-numbering year.
  const isoDayOfWeek = anchor.getUTCDay() === 0 ? 7 : anchor.getUTCDay();
  const thursday = new Date(anchor);
  thursday.setUTCDate(anchor.getUTCDate() + (4 - isoDayOfWeek));
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 1));
  const firstThursdayDow = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  firstThursday.setUTCDate(firstThursday.getUTCDate() + (4 - firstThursdayDow));
  const weekNumber =
    1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`;
}

function bucketBy(
  tips: Array<{ amount: number; createdAt: Date }>,
  keyFn: (date: Date, timeZone?: string) => string,
  timeZone?: string
): PeriodBucket[] {
  const buckets = new Map<string, { totalAmount: number; tipCount: number }>();
  for (const tip of tips) {
    const key = keyFn(tip.createdAt, timeZone);
    const existing = buckets.get(key) ?? { totalAmount: 0, tipCount: 0 };
    existing.totalAmount += tip.amount;
    existing.tipCount += 1;
    buckets.set(key, existing);
  }
  return Array.from(buckets.entries())
    .map(([period, stats]) => ({ period, ...stats }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

/**
 * Payment analytics dashboard data for a creator (issue #217).
 *
 * Tip rows for the requested range are fetched once and bucketed in
 * application code (day/week/ISO-week/month and top-supporters), rather
 * than with a raw `date_trunc` query: Prisma's query builder has no
 * timezone-aware date-bucketing of its own, and this codebase otherwise
 * never drops to raw SQL (`tip-filters.ts`'s whole premise is that the
 * query builder is sufficient). Each creator's own tip volume is bounded
 * (`MAX_TIPS_PER_AGGREGATION`), and the result is cached for an hour
 * (`CacheType.ANALYTICS`), so this trades a bit of CPU per cache miss for
 * not introducing a second query style.
 */
export class CreatorAnalyticsService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async getAnalytics(
    creatorId: string,
    filters: CreatorAnalyticsFilters = {}
  ): Promise<CreatorAnalytics> {
    return this.executeWithLogging('creatorAnalytics.getAnalytics', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
        select: { id: true },
      });
      if (!creator) {
        throw new NotFoundError('Creator');
      }

      const cacheKey = createCacheKey(
        CacheType.ANALYTICS,
        [
          creatorId,
          filters.minDate ?? '',
          filters.maxDate ?? '',
          filters.timezone ?? '',
          String(filters.topSupportersLimit ?? DEFAULT_TOP_SUPPORTERS_LIMIT),
        ].join(':')
      );

      return getOrFetch({
        key: cacheKey,
        type: CacheType.ANALYTICS,
        fetchFn: () => this.computeAnalytics(creatorId, filters),
      });
    });
  }

  private async computeAnalytics(
    creatorId: string,
    filters: CreatorAnalyticsFilters
  ): Promise<CreatorAnalytics> {
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (filters.minDate) createdAt.gte = resolveToUtc(filters.minDate, filters.timezone);
    if (filters.maxDate) createdAt.lte = resolveToUtc(filters.maxDate, filters.timezone);

    const tips = await this.prisma.tip.findMany({
      where: {
        creatorId,
        moderationState: TIP_VISIBLE_STATE,
        status: 'completed',
        ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
      },
      select: { amount: true, createdAt: true, fromUserId: true },
      take: MAX_TIPS_PER_AGGREGATION,
      orderBy: { createdAt: 'asc' },
    });

    const totalAmount = tips.reduce((sum, tip) => sum + tip.amount, 0);
    const totalTips = tips.length;

    const supporterTotals = new Map<string, { totalAmount: number; tipCount: number }>();
    for (const tip of tips) {
      const existing = supporterTotals.get(tip.fromUserId) ?? { totalAmount: 0, tipCount: 0 };
      existing.totalAmount += tip.amount;
      existing.tipCount += 1;
      supporterTotals.set(tip.fromUserId, existing);
    }

    const topSupporterLimit = Math.min(
      filters.topSupportersLimit ?? DEFAULT_TOP_SUPPORTERS_LIMIT,
      MAX_TOP_SUPPORTERS_LIMIT
    );
    const topSupporterIds = Array.from(supporterTotals.entries())
      .sort((a, b) => b[1].totalAmount - a[1].totalAmount)
      .slice(0, topSupporterLimit)
      .map(([userId]) => userId);

    const supporterUsers = topSupporterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: topSupporterIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(supporterUsers.map((user) => [user.id, user.name]));

    const topSupporters: TopSupporter[] = topSupporterIds.map((userId) => ({
      userId,
      name: nameById.get(userId) ?? null,
      ...supporterTotals.get(userId)!,
    }));

    return {
      creatorId,
      totalTips,
      totalAmount,
      averageTipAmount: totalTips > 0 ? totalAmount / totalTips : 0,
      daily: bucketBy(tips, dayKey, filters.timezone),
      weekly: bucketBy(tips, weekKey, filters.timezone),
      monthly: bucketBy(tips, monthKey, filters.timezone),
      topSupporters,
      generatedAt: new Date().toISOString(),
    };
  }
}
