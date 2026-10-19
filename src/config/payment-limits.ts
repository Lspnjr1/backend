/**
 * Minimum tip/payment amounts per currency (issue #218).
 *
 * A 0-value or dust-value tip still costs the creator and the network a fixed
 * fee, so it can lose money for everyone involved. This is the single source
 * of truth for the floor below which a tip is rejected: the payment schema
 * reads it for request-time validation and the service layer reads it again
 * so a caller that bypasses the route layer cannot create a sub-minimum tip
 * either.
 */

/**
 * Mirrors the `currency` enum in `payment.schemas.ts`'s `CreateTipSchema`.
 * Kept independent (rather than imported from there) so this config module
 * has no dependency on the schema module that reads it, avoiding a circular
 * import.
 */
export const TIP_CURRENCIES = ['USD', 'XLM', 'USDC'] as const;
export type TipCurrency = (typeof TIP_CURRENCIES)[number];

/** Minimum tip amount accepted for each supported currency. */
export const MINIMUM_TIP_AMOUNTS: Record<TipCurrency, number> = {
  XLM: 0.01,
  USDC: 0.01,
  USD: 0.5,
};

export const DEFAULT_MINIMUM_TIP_AMOUNT = MINIMUM_TIP_AMOUNTS.USD;

export function getMinimumTipAmount(currency: TipCurrency | undefined): number {
  if (!currency) return DEFAULT_MINIMUM_TIP_AMOUNT;
  return MINIMUM_TIP_AMOUNTS[currency] ?? DEFAULT_MINIMUM_TIP_AMOUNT;
}

export interface MinimumAmountCheck {
  valid: boolean;
  minimum: number;
  currency: TipCurrency;
}

/** Checks `amount` against the configured minimum for `currency`. */
export function checkMinimumTipAmount(
  amount: number,
  currency: TipCurrency | undefined
): MinimumAmountCheck {
  const resolvedCurrency = currency ?? 'USD';
  const minimum = getMinimumTipAmount(resolvedCurrency);
  return {
    valid: amount >= minimum,
    minimum,
    currency: resolvedCurrency,
  };
}
