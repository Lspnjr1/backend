/**
 * Shared runtime for creator tier enforcement (issue #69).
 *
 * One instance per process wires the pieces together so that every feature —
 * the tier routes, the analytics endpoints, background renewal — sees the same
 * cache, the same limiter and the same buffered usage counters:
 *
 *   - `resolver`  turns a user id into the tier they are entitled to and is
 *                 invalidated whenever a subscription write goes through;
 *   - `limiter`   enforces the per-creator minute/day budget;
 *   - `usage`     buffers month-to-date counters and flushes them in batches;
 *   - `service`   owns the subscription state machine and invoices.
 *
 * Building it here (rather than inside a route module) is what keeps tier
 * changes from being visible on one endpoint and invisible on another.
 */

import { PrismaClient } from '@prisma/client';
import { CreatorTierLimiter, getCreatorTierLimiter } from '../../lib/creator-tier-limits';
import { CreatorTierResolver, type CreatorTierMiddlewareOptions } from '../../middleware/creator-tier';
import { CreatorTierService, CreatorUsageService } from './tier.service';

export interface CreatorTierBenefits {
  feeRate: number;
  feeRatePercentage: number;
  payoutSchedule: 'monthly' | 'weekly' | 'instant' | string;
  instantPayouts: boolean;
  prioritySupport: boolean;
  customBranding: boolean;
  analyticsAccess: 'basic' | 'advanced' | 'full' | string;
}

export interface CreatorTierThresholds {
  minEarnings: number;
  minFollowers: number;
}

export interface CreatorMonetizationTierConfig {
  tier: 'free' | 'pro' | 'enterprise' | string;
  name: string;
  description: string;
  thresholds: CreatorTierThresholds;
  benefits: CreatorTierBenefits;
}

export const CREATOR_MONETIZATION_TIERS: CreatorMonetizationTierConfig[] = [
  {
    tier: 'free',
    name: 'Free Starter',
    description: 'Basic tier for new creators to receive tips and build an audience',
    thresholds: {
      minEarnings: 0,
      minFollowers: 0,
    },
    benefits: {
      feeRate: 0.05,
      feeRatePercentage: 5,
      payoutSchedule: 'monthly',
      instantPayouts: false,
      prioritySupport: false,
      customBranding: false,
      analyticsAccess: 'basic',
    },
  },
  {
    tier: 'pro',
    name: 'Pro Creator',
    description: 'Reduced platform fees and faster weekly/instant payouts for growing creators',
    thresholds: {
      minEarnings: 1000,
      minFollowers: 100,
    },
    benefits: {
      feeRate: 0.03,
      feeRatePercentage: 3,
      payoutSchedule: 'weekly',
      instantPayouts: true,
      prioritySupport: false,
      customBranding: true,
      analyticsAccess: 'advanced',
    },
  },
  {
    tier: 'enterprise',
    name: 'Enterprise VIP',
    description: 'Lowest platform fees, instant automated payouts, and dedicated priority support',
    thresholds: {
      minEarnings: 10000,
      minFollowers: 1000,
    },
    benefits: {
      feeRate: 0.01,
      feeRatePercentage: 1,
      payoutSchedule: 'instant',
      instantPayouts: true,
      prioritySupport: true,
      customBranding: true,
      analyticsAccess: 'full',
    },
  },
];

export interface CreatorTierProgression {
  currentTier: string;
  tierName: string;
  benefits: CreatorTierBenefits;
  metrics: {
    totalEarnings: number;
    followers: number;
  };
  progress: {
    earningsPercentage: number;
    followersPercentage: number;
    overallPercentage: number;
    earningsNeeded: number;
    followersNeeded: number;
  };
  nextTier: {
    tier: string;
    name: string;
    thresholds: CreatorTierThresholds;
    benefits: CreatorTierBenefits;
  } | null;
  simulation: {
    nextTier: string | null;
    targetEarnings: number | null;
    targetFollowers: number | null;
    earningsGap: number;
    followersGap: number;
    projectedFeeSavingsPercentage: number;
  };
  roadmap: Array<{
    tier: string;
    name: string;
    thresholds: CreatorTierThresholds;
    benefits: CreatorTierBenefits;
    unlocked: boolean;
    requiredEarnings: number;
    requiredFollowers: number;
  }>;
}

const TIER_ORDER: Record<string, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};

export function calculateCreatorTierProgression(
  rawEarnings: number,
  rawFollowers: number,
  subscribedTier?: string
): CreatorTierProgression {
  const earnings = Math.max(0, Number(rawEarnings) || 0);
  const followers = Math.max(0, Number(rawFollowers) || 0);

  // Check metrics qualification
  let qualifiedRank = 0;
  if (earnings >= 10000 && followers >= 1000) {
    qualifiedRank = 2; // enterprise
  } else if (earnings >= 1000 && followers >= 100) {
    qualifiedRank = 1; // pro
  } else {
    qualifiedRank = 0; // free
  }

  const subscribedRank = subscribedTier ? (TIER_ORDER[subscribedTier] ?? 0) : 0;
  const effectiveRank = Math.max(qualifiedRank, subscribedRank);
  const activeTierConfig = CREATOR_MONETIZATION_TIERS[effectiveRank] ?? CREATOR_MONETIZATION_TIERS[0];

  const hasNextTier = effectiveRank < CREATOR_MONETIZATION_TIERS.length - 1;
  const nextTierConfig = hasNextTier ? CREATOR_MONETIZATION_TIERS[effectiveRank + 1] : null;

  let earningsPercentage = 100;
  let followersPercentage = 100;
  let overallPercentage = 100;
  let earningsNeeded = 0;
  let followersNeeded = 0;

  if (nextTierConfig) {
    const targetEarnings = nextTierConfig.thresholds.minEarnings;
    const targetFollowers = nextTierConfig.thresholds.minFollowers;

    earningsPercentage =
      targetEarnings > 0 ? Math.min(100, Number(((earnings / targetEarnings) * 100).toFixed(1))) : 100;
    followersPercentage =
      targetFollowers > 0 ? Math.min(100, Number(((followers / targetFollowers) * 100).toFixed(1))) : 100;
    overallPercentage = Math.min(
      100,
      Number(((earningsPercentage + followersPercentage) / 2).toFixed(1))
    );

    earningsNeeded = Math.max(0, targetEarnings - earnings);
    followersNeeded = Math.max(0, targetFollowers - followers);
  }

  const simulation = {
    nextTier: nextTierConfig ? nextTierConfig.tier : null,
    targetEarnings: nextTierConfig ? nextTierConfig.thresholds.minEarnings : null,
    targetFollowers: nextTierConfig ? nextTierConfig.thresholds.minFollowers : null,
    earningsGap: earningsNeeded,
    followersGap: followersNeeded,
    projectedFeeSavingsPercentage: nextTierConfig
      ? Math.max(0, activeTierConfig.benefits.feeRatePercentage - nextTierConfig.benefits.feeRatePercentage)
      : 0,
  };

  const roadmap = CREATOR_MONETIZATION_TIERS.map((tierConfig) => {
    const rank = TIER_ORDER[tierConfig.tier] ?? 0;
    return {
      tier: tierConfig.tier,
      name: tierConfig.name,
      thresholds: tierConfig.thresholds,
      benefits: tierConfig.benefits,
      unlocked: rank <= effectiveRank,
      requiredEarnings: tierConfig.thresholds.minEarnings,
      requiredFollowers: tierConfig.thresholds.minFollowers,
    };
  });

  return {
    currentTier: activeTierConfig.tier,
    tierName: activeTierConfig.name,
    benefits: activeTierConfig.benefits,
    metrics: {
      totalEarnings: earnings,
      followers,
    },
    progress: {
      earningsPercentage,
      followersPercentage,
      overallPercentage,
      earningsNeeded,
      followersNeeded,
    },
    nextTier: nextTierConfig
      ? {
          tier: nextTierConfig.tier,
          name: nextTierConfig.name,
          thresholds: nextTierConfig.thresholds,
          benefits: nextTierConfig.benefits,
        }
      : null,
    simulation,
    roadmap,
  };
}

export interface CreatorTierRuntime {
  resolver: CreatorTierResolver;
  limiter: CreatorTierLimiter;
  usage: CreatorUsageService;
  service: CreatorTierService;
  /** Options bundle for `requireCreator` / `enforceCreatorQuota`. */
  middleware: CreatorTierMiddlewareOptions;
  /** Flushes buffered usage and stops timers. Safe to call more than once. */
  close(): Promise<void>;
}

export interface CreatorTierRuntimeOptions {
  /** Reuse an existing limiter (tests, or a Redis-backed replacement). */
  limiter?: CreatorTierLimiter;
  /** How often buffered usage is written to the database. */
  usageFlushIntervalMs?: number;
  /** How often expired rate-limit windows are dropped. */
  pruneIntervalMs?: number;
  /** Longest a resolved tier may be reused, in milliseconds. */
  resolverTtlMs?: number;
  now?: () => number;
  /** Set to false in tests to flush usage explicitly. */
  autoFlushUsage?: boolean;
  /** Set to false in tests to prune explicitly. */
  autoPrune?: boolean;
}

export function createCreatorTierRuntime(
  prisma: PrismaClient,
  options: CreatorTierRuntimeOptions = {}
): CreatorTierRuntime {
  const limiter = options.limiter ?? getCreatorTierLimiter();
  const resolver = new CreatorTierResolver(prisma, {
    ttlMs: options.resolverTtlMs,
    now: options.now,
  });

  const usage = new CreatorUsageService(prisma, {
    now: options.now,
    flushIntervalMs: options.usageFlushIntervalMs,
    autoFlush: options.autoFlushUsage,
  });

  const service = new CreatorTierService(prisma, {
    now: options.now,
    // A tier change must be visible on the very next request, so the cached
    // tier for that user is dropped instead of waiting for the TTL.
    onTierChanged: (userId) => resolver.invalidate(userId),
  });

  const pruneTimer =
    options.autoPrune === false
      ? null
      : setInterval(() => limiter.prune(), options.pruneIntervalMs ?? 5 * 60_000);
  // Never keep the process alive just to prune counters.
  pruneTimer?.unref?.();

  let closed = false;

  return {
    resolver,
    limiter,
    usage,
    service,
    middleware: { resolver, limiter, recorder: usage },
    async close() {
      if (closed) return;
      closed = true;
      if (pruneTimer) clearInterval(pruneTimer);
      // Buffered counters are usage data the creator may have paid for; lose as
      // little of it as possible on shutdown.
      await usage.flush().catch(() => undefined);
      usage.stop();
    },
  };
}
