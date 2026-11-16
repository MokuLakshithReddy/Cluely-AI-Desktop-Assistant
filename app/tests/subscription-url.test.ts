import { describe, expect, it } from 'vitest';
import { getSubscriptionPageUrl, SCANDIUM_PRICING_PAGE_URL } from '../src/lib/subscription';

describe('First-party subscription page URLs', () => {
  it('opens the Scandium pricing page with the selected plan highlighted', () => {
    expect(getSubscriptionPageUrl('plus')).toBe(SCANDIUM_PRICING_PAGE_URL + '?plan=plus#plans');
    expect(getSubscriptionPageUrl('pro')).toBe(SCANDIUM_PRICING_PAGE_URL + '?plan=pro#plans');
  });
});
