export type ScandiumPaidPlan = 'plus' | 'pro';

export const SCANDIUM_PRICING_PAGE_URL =
  'https://mokulakshithreddy.github.io/Scandium-Assistant/';

export function getSubscriptionPageUrl(plan: ScandiumPaidPlan): string {
  const url = new URL(SCANDIUM_PRICING_PAGE_URL);
  url.searchParams.set('plan', plan);
  url.hash = 'plans';
  return url.toString();
}
