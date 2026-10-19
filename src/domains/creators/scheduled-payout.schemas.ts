import { z } from 'zod';
import { SCHEDULED_PAYOUT_PRESETS, validateCronExpression } from '../../lib/cron';

/**
 * Request/response schemas for scheduled creator payouts (#222).
 *
 * A request supplies either a named `recurrence` preset (daily/weekly/monthly)
 * or a raw `cronExpression` for a custom schedule; exactly one of the two is
 * required, and a supplied `cronExpression` is validated with the real cron
 * parser (`validateCronExpression`) so an invalid expression is rejected with
 * a 400 before anything is persisted or scheduled.
 */
export const ScheduledPayoutRecurrenceSchema = z.enum(
  Object.keys(SCHEDULED_PAYOUT_PRESETS) as [keyof typeof SCHEDULED_PAYOUT_PRESETS]
);

export const CreateScheduledPayoutSchema = z
  .object({
    amount: z
      .number()
      .finite('Amount must be a finite number')
      .positive('Amount must be greater than 0'),
    walletAddress: z.string().trim().min(1).optional(),
    recurrence: ScheduledPayoutRecurrenceSchema.optional(),
    cronExpression: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.recurrence && !data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recurrence'],
        message:
          'Either recurrence (daily, weekly, monthly) or a custom cronExpression is required',
      });
      return;
    }
    if (data.recurrence && data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cronExpression'],
        message: 'Provide either recurrence or cronExpression, not both',
      });
      return;
    }
    if (data.cronExpression) {
      const check = validateCronExpression(data.cronExpression);
      if (!check.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cronExpression'],
          message: check.reason ?? 'Invalid cron expression',
        });
      }
    }
  });

export type CreateScheduledPayoutInput = z.infer<typeof CreateScheduledPayoutSchema>;

export const ScheduledPayoutIdParamsSchema = z.object({
  id: z.string().trim().min(1, 'Scheduled payout ID is required'),
});

export type ScheduledPayoutIdParams = z.infer<typeof ScheduledPayoutIdParamsSchema>;
