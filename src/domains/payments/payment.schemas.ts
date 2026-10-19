import { z } from 'zod';
import { sanitizeText, stripHtml } from '../../utils/sanitization';
import {
  ASSET_CODE_MAX_LENGTH,
  MAX_PAYMENT_AMOUNT,
  MEMO_MAX_LENGTH,
  isValidAssetCode,
  isValidStellarPublicKey,
  validateMemo,
} from '../../lib/stellar/validation';
import { zodToJsonSchema } from '../../utils/zod-to-json-schema';
import { TIP_TEXT_SEARCH_MAX_LENGTH } from './tip-filters';
import { MAX_MEDIA_PER_TIP } from '../media/media.types';
import { getMinimumTipAmount } from '../../config/payment-limits';

/**
 * Request schemas for the payments domain.
 *
 * These are the single source of truth for request validation: routes validate
 * with them (before touching the service/database) and the OpenAPI schemas at
 * the bottom of this file are derived from them, so documentation cannot drift
 * from enforcement.
 */

export const TipStatusEnum = z.enum(['pending', 'completed', 'failed', 'cancelled']);

export const ALLOWED_SORT_FIELDS = ['createdAt', 'amount', 'status', 'id', 'updatedAt'] as const;

export const StellarPublicKeySchema = z
  .string()
  .trim()
  .refine(isValidStellarPublicKey, { message: 'Invalid Stellar public key' });

/**
 * Text memo attached to a Stellar payment transaction (#180).
 *
 * The protocol caps MEMO_TEXT at MEMO_MAX_LENGTH (28) bytes, counted after
 * UTF-8 encoding: 28 ASCII characters fit, 15 two byte characters do not. The
 * check reuses `validateMemo` and runs with the rest of the request validation,
 * so an oversized memo is answered with a 400 field error naming the byte limit
 * before any transaction is built.
 */
export const MemoSchema = z
  .string()
  .trim()
  .min(1, 'Memo cannot be empty')
  .transform((value) => stripHtml(value))
  .superRefine((value, ctx) => {
    const check = validateMemo(value);
    if (!check.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: check.reason ?? `Memo must be at most ${MEMO_MAX_LENGTH} UTF-8 bytes`,
      });
    }
  })
  .describe(`Stellar text memo, at most ${MEMO_MAX_LENGTH} bytes when encoded as UTF-8`);

/** Text fields are sanitized (HTML stripped) then truncated to maxLength. */
const sanitizedText = (maxLength: number, label: string) =>
  z
    .string()
    .transform((value) => sanitizeText(value, { maxLength }))
    .pipe(z.string().max(maxLength, `${label} must be ${maxLength} characters or less`));

const sortBySchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) =>
      value
        .split(',')
        .map((field) => field.trim().replace(/^[+-]/, ''))
        .filter(Boolean)
        .every((field) => (ALLOWED_SORT_FIELDS as readonly string[]).includes(field)),
    { message: `sortBy must be a comma separated list of: ${ALLOWED_SORT_FIELDS.join(', ')}` }
  );

const sortOrderSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['asc', 'desc']));

const boundedInt = (min: number, max: number, label: string) =>
  z.coerce
    .number()
    .int(`${label} must be an integer`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must not exceed ${max}`);

const boundedNumber = (min: number, max: number, label: string) =>
  z.coerce
    .number()
    .finite(`${label} must be a finite number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must not exceed ${max}`);

/**
 * Accepts any parseable date-time, trimmed but otherwise unmodified.
 *
 * Deliberately does *not* eagerly normalize via `new Date(value).toISOString()`
 * (issue #216): that would resolve a bare, offset-less value against the
 * server process's local timezone right here, before the `timezone` field is
 * even available, and would erase whether the original value had an explicit
 * UTC offset at all — information `resolveToUtc` (src/utils/timezone.ts)
 * needs to decide whether `timezone` should apply. Resolution happens once,
 * in `buildTipWhere`, with both `minDate`/`maxDate` and `timezone` in hand.
 */
const isoDateSchema = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), `${label} must be an ISO-8601 date-time`);

/** `America/New_York`-style IANA timezone identifier (issue #216). */
const timezoneSchema = z
  .string()
  .trim()
  .min(1, 'timezone must not be empty')
  .max(64, 'timezone is too long')
  .refine((value) => {
    try {
      Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'timezone must be a valid IANA timezone identifier');

/**
 * POST /api/v1/transactions/tip
 *
 * Amounts below the configured per-currency minimum are rejected (#218): a
 * 0-value or dust-value tip can cost more in network/processing fees than the
 * tip itself is worth. The check runs in a `superRefine` (rather than a plain
 * `.min()` on `amount`) because the floor depends on `currency`, a sibling
 * field, so both values must be read together. The error carries the minimum
 * amount and currency so clients can surface exactly how much more is needed.
 */
export const CreateTipSchema = z
  .object({
    creatorId: z.string().trim().min(1, 'Creator ID is required').max(100, 'Creator ID is too long'),
    amount: z
      .number()
      .finite('Amount must be a finite number')
      .positive('Amount must be greater than 0')
      .max(MAX_PAYMENT_AMOUNT, `Amount must not exceed ${MAX_PAYMENT_AMOUNT}`),
    message: sanitizedText(500, 'Message').optional(),
    currency: z.enum(['USD', 'XLM', 'USDC']).default('USD'),
    assetId: z.string().trim().min(1).max(100).optional(),
    idempotencyKey: z.string().trim().min(8, 'Idempotency key is too short').max(255).optional(),
    /**
     * Media uploaded beforehand and attached to this tip's message (#64). Every
     * id must belong to the tipper and be in the `ready` state.
     */
    mediaIds: z
      .array(z.string().trim().min(1, 'Media ID is required').max(100, 'Media ID is too long'))
      .max(MAX_MEDIA_PER_TIP, `A tip can carry at most ${MAX_MEDIA_PER_TIP} media items`)
      .optional(),
  })
  .superRefine((data, ctx) => {
    const minimum = getMinimumTipAmount(data.currency);
    if (data.amount < minimum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: `Amount must be at least ${minimum} ${data.currency} (minimum tip amount)`,
        params: { minimumAmount: minimum, currency: data.currency },
      });
    }
  });

/**
 * PATCH /api/v1/transactions/:id/status
 */
export const UpdateTipStatusSchema = z.object({
  status: TipStatusEnum,
  transactionHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i, 'transactionHash must be a 64 character hex string')
    .optional(),
});

/**
 * POST /api/v1/transactions/:id/build
 */
export const BuildPaymentTransactionSchema = z.object({
  senderPublicKey: StellarPublicKeySchema,
  creatorPublicKey: StellarPublicKeySchema,
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,7})?$/, 'Invalid amount format')
    .refine((value) => Number(value) > 0, 'Amount must be greater than 0')
    .refine((value) => Number(value) <= MAX_PAYMENT_AMOUNT, `Amount must not exceed ${MAX_PAYMENT_AMOUNT}`),
  assetCode: z
    .string()
    .trim()
    .max(ASSET_CODE_MAX_LENGTH)
    .refine(isValidAssetCode, 'Invalid asset code')
    .optional(),
  assetIssuer: StellarPublicKeySchema.optional(),
  /**
   * Optional text memo for the on-chain payment, limited to MEMO_MAX_LENGTH
   * (28) UTF-8 bytes (see `MemoSchema`). When omitted the service derives the
   * memo from the tip id.
   */
  memo: MemoSchema.optional(),
});

/**
 * POST /api/v1/transactions/:id/submit
 */
export const SubmitPaymentTransactionSchema = z.object({
  transactionEnvelope: z
    .string()
    .trim()
    .min(1, 'Transaction envelope is required')
    .max(100_000, 'Transaction envelope is too large'),
});

/**
 * GET /api/v1/transactions/:id and confirm/status routes
 */
export const TipIdParamsSchema = z.object({
  id: z.string().trim().min(1, 'Tip ID is required').max(64, 'Tip ID is too long'),
});

/**
 * GET /api/v1/transactions/creator/:creatorId
 */
export const CreatorIdParamsSchema = z.object({
  creatorId: z.string().trim().min(1, 'Creator ID is required').max(100, 'Creator ID is too long'),
});

/**
 * Pagination/filtering query shared by history and creator listings.
 *
 * Besides pagination and sorting it accepts the database-side filters added for
 * #56: date range, amount range, status, free-text search, sender and creator.
 * Every filter is optional and combined with AND by `buildTipWhere`.
 */
export const TipHistoryQuerySchema = z
  .object({
    page: boundedInt(1, 1_000_000, 'page').optional(),
    pageSize: boundedInt(1, 100, 'pageSize').optional(),
    limit: boundedInt(1, 100, 'limit').optional(),
    cursor: z.string().trim().max(512).optional(),
    after: z.string().trim().max(512).optional(),
    first: boundedInt(1, 100, 'first').optional(),
    sortBy: sortBySchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    status: TipStatusEnum.optional(),
    // --- Filters (#56) -----------------------------------------------------
    minDate: isoDateSchema('minDate').optional(),
    maxDate: isoDateSchema('maxDate').optional(),
    // IANA timezone used to interpret minDate/maxDate when they carry no
    // explicit UTC offset, and to format response timestamps (issue #216).
    timezone: timezoneSchema.optional(),
    minAmount: boundedNumber(0, MAX_PAYMENT_AMOUNT, 'minAmount').optional(),
    maxAmount: boundedNumber(0, MAX_PAYMENT_AMOUNT, 'maxAmount').optional(),
    query: sanitizedText(TIP_TEXT_SEARCH_MAX_LENGTH, 'Search query').optional(),
    fromUserId: z.string().trim().min(1, 'fromUserId is required').max(100).optional(),
    creatorId: z.string().trim().min(1, 'creatorId is required').max(100).optional(),
  })
  .refine(
    (q) => !q.minDate || !q.maxDate || Date.parse(q.minDate) <= Date.parse(q.maxDate),
    { message: 'minDate must be before or equal to maxDate', path: ['minDate'] }
  )
  .refine(
    (q) => q.minAmount === undefined || q.maxAmount === undefined || q.minAmount <= q.maxAmount,
    { message: 'minAmount must be less than or equal to maxAmount', path: ['minAmount'] }
  );

export type CreateTipInput = z.infer<typeof CreateTipSchema>;
export type UpdateTipStatusInput = z.infer<typeof UpdateTipStatusSchema>;
export type BuildPaymentTransactionInput = z.infer<typeof BuildPaymentTransactionSchema>;
export type SubmitPaymentTransactionInput = z.infer<typeof SubmitPaymentTransactionSchema>;
export type TipHistoryQueryInput = z.infer<typeof TipHistoryQuerySchema>;

/**
 * JSON schemas derived from the Zod schemas above, attached to Fastify routes so
 * `/docs` always reflects the real validation rules.
 */
export const createTipJsonSchema = zodToJsonSchema(CreateTipSchema);
export const updateTipStatusJsonSchema = zodToJsonSchema(UpdateTipStatusSchema);
export const buildPaymentTransactionJsonSchema = zodToJsonSchema(BuildPaymentTransactionSchema);
export const submitPaymentTransactionJsonSchema = zodToJsonSchema(SubmitPaymentTransactionSchema);
export const tipIdParamsJsonSchema = zodToJsonSchema(TipIdParamsSchema);
export const creatorIdParamsJsonSchema = zodToJsonSchema(CreatorIdParamsSchema);
export const tipHistoryQueryJsonSchema = zodToJsonSchema(TipHistoryQuerySchema);
