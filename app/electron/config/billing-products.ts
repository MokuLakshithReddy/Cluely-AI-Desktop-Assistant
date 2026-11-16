/**
 * Public Lemon Squeezy product/variant allow-list.
 * Fill both IDs for each plan only after creating the real Scandium products.
 * Public IDs are not API secrets. Process environment overrides support local
 * tests and CI; packaged builds should include the production IDs here.
 * Empty IDs intentionally keep all unconfigured paid licenses at Free tier.
 */
export const BILLING_PRODUCTS = {
  plus: { productId: '', variantId: '' },
  pro: { productId: '', variantId: '' },
} as const;
