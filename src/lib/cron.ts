/**
 * Cron expression validation and named presets for scheduled payments (#222).
 *
 * Validation delegates to `cron-parser` (already an installed dependency of
 * `bullmq`, added here as a direct dependency since this module relies on it
 * directly rather than transitively) instead of hand-rolling a parser: it is
 * the same library bullmq's own repeatable-job scheduling uses internally, so
 * "this cron expression validates" and "bullmq will accept this cron
 * expression" stay the same claim.
 *
 * `cron-parser`'s CommonJS export does not survive Node's ESM/CJS interop as
 * a plain named import (`import { parseExpression } from 'cron-parser'`
 * resolves to `undefined` at runtime under both `tsx` and Vitest); the
 * default-import form below is the one that actually works, the same fix
 * needed for `archiver` elsewhere in this codebase.
 */
import cronParser from 'cron-parser';

/** Named recurrence presets a creator can pick instead of writing raw cron. */
export const SCHEDULED_PAYOUT_PRESETS = {
  daily: '0 0 * * *',
  weekly: '0 0 * * 0',
  monthly: '0 0 1 * *',
} as const;

export type ScheduledPayoutPresetName = keyof typeof SCHEDULED_PAYOUT_PRESETS;

export function isScheduledPayoutPresetName(value: unknown): value is ScheduledPayoutPresetName {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SCHEDULED_PAYOUT_PRESETS, value)
  );
}

export interface CronValidationResult {
  valid: boolean;
  reason?: string;
}

/** Validates a standard 5-field cron expression using the real cron parser. */
export function validateCronExpression(expression: string): CronValidationResult {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    return { valid: false, reason: 'Cron expression is required' };
  }

  try {
    cronParser.parseExpression(expression);
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: (error as Error).message || 'Invalid cron expression' };
  }
}

/** The next run time for a cron expression, or null if it cannot be parsed. */
export function nextCronRun(expression: string, from?: Date): Date | null {
  try {
    const interval = cronParser.parseExpression(
      expression,
      from ? { currentDate: from } : undefined
    );
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/** Resolves a named recurrence preset or raw cron expression to the cron string to store/use. */
export function resolveCronExpression(input: {
  recurrence?: string;
  cronExpression?: string;
}): string | null {
  if (input.cronExpression) {
    return input.cronExpression;
  }
  if (input.recurrence && isScheduledPayoutPresetName(input.recurrence)) {
    return SCHEDULED_PAYOUT_PRESETS[input.recurrence];
  }
  return null;
}
