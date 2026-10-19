import { describe, it, expect } from 'vitest';
import {
  SCHEDULED_PAYOUT_PRESETS,
  isScheduledPayoutPresetName,
  nextCronRun,
  resolveCronExpression,
  validateCronExpression,
} from '../cron';

/**
 * Regression tests for the cron validation/resolution helpers backing #222's
 * scheduled payouts. The preset cron strings are asserted against their
 * literal standard-cron-syntax values (not re-derived), so a typo in a
 * preset's cron string (e.g. "weekly" silently becoming daily) is caught
 * here.
 */
describe('cron helpers (#222)', () => {
  describe('SCHEDULED_PAYOUT_PRESETS', () => {
    it('daily preset is midnight every day', () => {
      expect(SCHEDULED_PAYOUT_PRESETS.daily).toBe('0 0 * * *');
    });

    it('weekly preset is midnight every Sunday', () => {
      expect(SCHEDULED_PAYOUT_PRESETS.weekly).toBe('0 0 * * 0');
    });

    it('monthly preset is midnight on the 1st of each month', () => {
      expect(SCHEDULED_PAYOUT_PRESETS.monthly).toBe('0 0 1 * *');
    });
  });

  describe('isScheduledPayoutPresetName', () => {
    it('accepts the three known preset names', () => {
      expect(isScheduledPayoutPresetName('daily')).toBe(true);
      expect(isScheduledPayoutPresetName('weekly')).toBe(true);
      expect(isScheduledPayoutPresetName('monthly')).toBe(true);
    });

    it('rejects an unknown name', () => {
      expect(isScheduledPayoutPresetName('yearly')).toBe(false);
      expect(isScheduledPayoutPresetName('')).toBe(false);
      expect(isScheduledPayoutPresetName(123)).toBe(false);
    });
  });

  describe('validateCronExpression', () => {
    it('accepts a valid standard 5-field cron expression', () => {
      expect(validateCronExpression('0 0 * * *').valid).toBe(true);
      expect(validateCronExpression('*/15 * * * *').valid).toBe(true);
      expect(validateCronExpression('0 9 * * 1-5').valid).toBe(true);
    });

    it('rejects an empty or missing expression', () => {
      expect(validateCronExpression('').valid).toBe(false);
      expect(validateCronExpression('   ').valid).toBe(false);
    });

    it('rejects a structurally invalid expression', () => {
      const result = validateCronExpression('not a cron expression');
      expect(result.valid).toBe(false);
      expect(result.reason).toBeTruthy();
    });

    it('rejects an out-of-range field', () => {
      // Minute field only accepts 0-59.
      expect(validateCronExpression('99 0 * * *').valid).toBe(false);
    });
  });

  describe('nextCronRun', () => {
    it('returns a future date for a valid expression', () => {
      const from = new Date('2026-01-01T00:00:00.000Z');
      const next = nextCronRun('0 0 * * *', from);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(from.getTime());
    });

    it('returns null for an invalid expression', () => {
      expect(nextCronRun('garbage')).toBeNull();
    });
  });

  describe('resolveCronExpression', () => {
    it('prefers an explicit cronExpression over a recurrence preset', () => {
      const resolved = resolveCronExpression({
        recurrence: 'daily',
        cronExpression: '*/5 * * * *',
      });
      expect(resolved).toBe('*/5 * * * *');
    });

    it('resolves a known recurrence preset name to its cron string', () => {
      expect(resolveCronExpression({ recurrence: 'weekly' })).toBe('0 0 * * 0');
    });

    it('returns null when neither recurrence nor cronExpression is given', () => {
      expect(resolveCronExpression({})).toBeNull();
    });

    it('returns null for an unknown recurrence name with no cronExpression', () => {
      expect(resolveCronExpression({ recurrence: 'yearly' })).toBeNull();
    });
  });
});
