/**
 * Public Paddle Billing price ID allow-list.
 *
 * Fill price IDs for each plan only after creating the real Scandium products in Paddle Billing.
 * Format: 'pri_01...'
 * Public price IDs are not API secrets. Process environment overrides support local
 * tests and CI; packaged builds should include the production price IDs here.
 * Empty IDs intentionally keep all unconfigured paid licenses at Free tier.
 */
export interface BillingPlanConfig {
  priceId: string;
}

export const PADDLE_PRODUCTS: Record<'plus' | 'pro', BillingPlanConfig> = {
  plus: { priceId: '' },
  pro: { priceId: '' },
} as const;

/**
 * Provider-independent billing plan definitions.
 */
export const BILLING_PRODUCTS = {
  plus: { priceId: '', productId: '', variantId: '' },
  pro: { priceId: '', productId: '', variantId: '' },
} as const;
