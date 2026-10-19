import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import {
  calculateCreatorTierProgression,
  CREATOR_MONETIZATION_TIERS,
  createCreatorTierRuntime,
} from '../tier.runtime';
import { registerCreatorTierRoutes } from '../tier.routes';
import { FakeTierPrisma, asPrisma } from './fake-tier-prisma';
import { CreatorTierLimiter } from '../../../lib/creator-tier-limits';

const { authMiddlewareMock } = vi.hoisted(() => ({
  authMiddlewareMock: vi.fn(),
}));
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
}));

function setUser(userId = 'user_1') {
  authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
    request.user = { userId, email: 'creator@example.com', role: 'user' };
  });
}

describe('Creator Tier Progression Calculation', () => {
  it('calculates starter tier for zero earnings and followers', () => {
    const progression = calculateCreatorTierProgression(0, 0);

    expect(progression.currentTier).toBe('free');
    expect(progression.tierName).toBe('Free Starter');
    expect(progression.benefits.feeRatePercentage).toBe(5);
    expect(progression.benefits.payoutSchedule).toBe('monthly');
    expect(progression.metrics.totalEarnings).toBe(0);
    expect(progression.metrics.followers).toBe(0);
    expect(progression.progress.earningsPercentage).toBe(0);
    expect(progression.progress.followersPercentage).toBe(0);
    expect(progression.progress.overallPercentage).toBe(0);
    expect(progression.progress.earningsNeeded).toBe(1000);
    expect(progression.progress.followersNeeded).toBe(100);

    expect(progression.nextTier).not.toBeNull();
    expect(progression.nextTier?.tier).toBe('pro');
    expect(progression.nextTier?.thresholds.minEarnings).toBe(1000);
    expect(progression.nextTier?.thresholds.minFollowers).toBe(100);

    expect(progression.simulation.nextTier).toBe('pro');
    expect(progression.simulation.earningsGap).toBe(1000);
    expect(progression.simulation.followersGap).toBe(100);
    expect(progression.simulation.projectedFeeSavingsPercentage).toBe(2);

    expect(progression.roadmap).toHaveLength(3);
    expect(progression.roadmap[0].unlocked).toBe(true);
    expect(progression.roadmap[1].unlocked).toBe(false);
    expect(progression.roadmap[2].unlocked).toBe(false);
  });

  it('calculates mid-tier progress accurately', () => {
    const progression = calculateCreatorTierProgression(500, 50);

    expect(progression.currentTier).toBe('free');
    expect(progression.progress.earningsPercentage).toBe(50);
    expect(progression.progress.followersPercentage).toBe(50);
    expect(progression.progress.overallPercentage).toBe(50);
    expect(progression.progress.earningsNeeded).toBe(500);
    expect(progression.progress.followersNeeded).toBe(50);
    expect(progression.simulation.earningsGap).toBe(500);
    expect(progression.simulation.followersGap).toBe(50);
  });

  it('qualifies for pro tier once thresholds are met', () => {
    const progression = calculateCreatorTierProgression(1500, 150);

    expect(progression.currentTier).toBe('pro');
    expect(progression.tierName).toBe('Pro Creator');
    expect(progression.benefits.feeRatePercentage).toBe(3);
    expect(progression.benefits.payoutSchedule).toBe('weekly');
    expect(progression.benefits.instantPayouts).toBe(true);

    expect(progression.nextTier).not.toBeNull();
    expect(progression.nextTier?.tier).toBe('enterprise');
    expect(progression.progress.earningsPercentage).toBe(15);
    expect(progression.progress.followersPercentage).toBe(15);
    expect(progression.progress.earningsNeeded).toBe(8500);
    expect(progression.progress.followersNeeded).toBe(850);
    expect(progression.simulation.projectedFeeSavingsPercentage).toBe(2);

    expect(progression.roadmap[0].unlocked).toBe(true);
    expect(progression.roadmap[1].unlocked).toBe(true);
    expect(progression.roadmap[2].unlocked).toBe(false);
  });

  it('qualifies for enterprise VIP tier at highest thresholds', () => {
    const progression = calculateCreatorTierProgression(15000, 2000);

    expect(progression.currentTier).toBe('enterprise');
    expect(progression.tierName).toBe('Enterprise VIP');
    expect(progression.benefits.feeRatePercentage).toBe(1);
    expect(progression.benefits.payoutSchedule).toBe('instant');
    expect(progression.benefits.prioritySupport).toBe(true);

    expect(progression.nextTier).toBeNull();
    expect(progression.progress.earningsPercentage).toBe(100);
    expect(progression.progress.followersPercentage).toBe(100);
    expect(progression.progress.overallPercentage).toBe(100);
    expect(progression.progress.earningsNeeded).toBe(0);
    expect(progression.progress.followersNeeded).toBe(0);
    expect(progression.simulation.nextTier).toBeNull();
    expect(progression.simulation.earningsGap).toBe(0);
    expect(progression.simulation.followersGap).toBe(0);

    expect(progression.roadmap.every((r) => r.unlocked)).toBe(true);
  });

  it('handles subscribed tier override even if metrics are lower', () => {
    const progression = calculateCreatorTierProgression(100, 5, 'pro');

    expect(progression.currentTier).toBe('pro');
    expect(progression.tierName).toBe('Pro Creator');
    expect(progression.benefits.feeRatePercentage).toBe(3);
    expect(progression.nextTier?.tier).toBe('enterprise');
  });

  it('clamps negative inputs gracefully', () => {
    const progression = calculateCreatorTierProgression(-500, -10);

    expect(progression.metrics.totalEarnings).toBe(0);
    expect(progression.metrics.followers).toBe(0);
    expect(progression.currentTier).toBe('free');
  });
});

describe('GET /api/creators/me/tier endpoint', () => {
  beforeEach(() => {
    authMiddlewareMock.mockReset();
    setUser('user_test_1');
  });

  it('returns creator current tier, benefits, progress, and roadmap', async () => {
    const fake = new FakeTierPrisma();
    fake.seedCreator({
      userId: 'user_test_1',
      id: 'creator_1',
      totalEarnings: 500,
    } as any);

    const app = Fastify({ logger: false });
    const limiter = new CreatorTierLimiter();
    const runtime = createCreatorTierRuntime(asPrisma(fake), {
      limiter,
      autoFlushUsage: false,
      autoPrune: false,
    });
    registerCreatorTierRoutes(app, asPrisma(fake), { runtime });

    const response = await app.inject({
      method: 'GET',
      url: '/api/creators/me/tier',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.tier).toBe('free');
    expect(body.data.tierName).toBe('Free Starter');
    expect(body.data.benefits).toBeDefined();
    expect(body.data.benefits.feeRatePercentage).toBe(5);
    expect(body.data.benefits.payoutSchedule).toBe('monthly');
    expect(body.data.progress).toBeDefined();
    expect(body.data.progress.earningsPercentage).toBe(50);
    expect(body.data.roadmap).toBeDefined();
    expect(body.data.roadmap).toHaveLength(3);
    expect(body.data.roadmap[0].tier).toBe('free');
    expect(body.data.roadmap[1].tier).toBe('pro');
    expect(body.data.roadmap[2].tier).toBe('enterprise');

    await runtime.close();
  });

  it('supports simulation parameters for roadmap planning', async () => {
    const fake = new FakeTierPrisma();
    fake.seedCreator({
      userId: 'user_test_1',
      id: 'creator_1',
      totalEarnings: 0,
    } as any);

    const app = Fastify({ logger: false });
    const limiter = new CreatorTierLimiter();
    const runtime = createCreatorTierRuntime(asPrisma(fake), {
      limiter,
      autoFlushUsage: false,
      autoPrune: false,
    });
    registerCreatorTierRoutes(app, asPrisma(fake), { runtime });

    const response = await app.inject({
      method: 'GET',
      url: '/api/creators/me/tier?simulateEarnings=1500&simulateFollowers=150',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.tierName).toBe('Pro Creator');
    expect(body.data.metrics.totalEarnings).toBe(1500);
    expect(body.data.metrics.followers).toBe(150);
    expect(body.data.benefits.feeRatePercentage).toBe(3);

    await runtime.close();
  });
});
