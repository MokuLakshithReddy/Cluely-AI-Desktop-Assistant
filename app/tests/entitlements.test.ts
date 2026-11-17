import { describe, it, expect } from 'vitest';
import {
  getEntitlements,
  isModeAllowed,
  canUseByokProvider,
  isDeveloperEntitlementOverrideEnabled,
  getEffectiveEntitlementTier,
  TIER_ENTITLEMENTS,
  SubscriptionTier,
} from '../electron/domains/entitlements';
import {
  getEntitlements as getClientEntitlements,
  isModeAllowed as isClientModeAllowed,
  canUseByokProvider as canClientUseByokProvider,
} from '../src/lib/entitlements';

describe('Commercial Subscription & Entitlements Matrix', () => {
  it('correctly maps Free tier restrictions', () => {
    const entitlements = getEntitlements('free');
    expect(entitlements.tier).toBe('free');
    expect(entitlements.maxDeviceSlots).toBe(1);
    expect(entitlements.allowedModes).toEqual(['copilot']);
    expect(entitlements.canUseLocalWhisper).toBe(false);
    expect(entitlements.canUseLocalVision).toBe(false);
    expect(entitlements.canUseCloudByok).toBe(false);
    expect(entitlements.allowedByokProviders).toHaveLength(0);
    expect(entitlements.canUseKnowledgeRag).toBe(false);
    expect(entitlements.maxKnowledgeDocuments).toBe(0);
  });

  it('correctly maps Plus tier capabilities', () => {
    const entitlements = getEntitlements('plus');
    expect(entitlements.tier).toBe('plus');
    expect(entitlements.maxDeviceSlots).toBe(2);
    expect(entitlements.allowedModes).toContain('coding');
    expect(entitlements.allowedModes).toContain('sales');
    expect(entitlements.allowedModes).not.toContain('interview');
    expect(entitlements.canUseLocalWhisper).toBe(true);
    expect(entitlements.canUseLocalVision).toBe(true);
    expect(entitlements.canUseCloudByok).toBe(true);
    expect(entitlements.allowedByokProviders).toEqual(['gemini', 'groq']);
    expect(entitlements.canUseKnowledgeRag).toBe(true);
    expect(entitlements.maxKnowledgeDocuments).toBe(20);
  });

  it('correctly maps Pro tier capabilities', () => {
    const entitlements = getEntitlements('pro');
    expect(entitlements.tier).toBe('pro');
    expect(entitlements.maxDeviceSlots).toBe(5);
    expect(entitlements.allowedModes).toContain('interview');
    expect(entitlements.allowedModes).toContain('executive');
    expect(entitlements.canUseLocalWhisper).toBe(true);
    expect(entitlements.canUseLocalVision).toBe(true);
    expect(entitlements.canUseCloudByok).toBe(true);
    expect(entitlements.allowedByokProviders).toEqual(['gemini', 'openai', 'anthropic', 'groq']);
    expect(entitlements.canUseKnowledgeRag).toBe(true);
    expect(entitlements.maxKnowledgeDocuments).toBe(100);
  });

  it('enforces mode gating across tiers', () => {
    expect(isModeAllowed('free', 'copilot')).toBe(true);
    expect(isModeAllowed('free', 'coding')).toBe(false);
    expect(isModeAllowed('free', 'sales')).toBe(false);

    expect(isModeAllowed('plus', 'copilot')).toBe(true);
    expect(isModeAllowed('plus', 'coding')).toBe(true);
    expect(isModeAllowed('plus', 'sales')).toBe(true);
    expect(isModeAllowed('plus', 'interview')).toBe(false);

    expect(isModeAllowed('pro', 'interview')).toBe(true);
    expect(isModeAllowed('pro', 'executive')).toBe(true);
  });

  it('enforces BYOK provider gating across tiers', () => {
    expect(canUseByokProvider('free', 'gemini')).toBe(false);
    expect(canUseByokProvider('free', 'openai')).toBe(false);

    expect(canUseByokProvider('plus', 'gemini')).toBe(true);
    expect(canUseByokProvider('plus', 'groq')).toBe(true);
    expect(canUseByokProvider('plus', 'openai')).toBe(false);
    expect(canUseByokProvider('plus', 'anthropic')).toBe(false);

    expect(canUseByokProvider('pro', 'openai')).toBe(true);
    expect(canUseByokProvider('pro', 'anthropic')).toBe(true);
  });

  it('enables the developer override only with an explicit flag in an unpackaged non-production build', () => {
    expect(isDeveloperEntitlementOverrideEnabled('true', false, 'development')).toBe(true);
    expect(isDeveloperEntitlementOverrideEnabled('true', false, undefined)).toBe(true);
    expect(isDeveloperEntitlementOverrideEnabled(undefined, false, 'development')).toBe(false);
    expect(isDeveloperEntitlementOverrideEnabled('false', false, 'development')).toBe(false);
    expect(isDeveloperEntitlementOverrideEnabled('TRUE', false, 'development')).toBe(false);
    expect(isDeveloperEntitlementOverrideEnabled('true', false, 'production')).toBe(false);
    expect(isDeveloperEntitlementOverrideEnabled('true', true, 'development')).toBe(false);
  });

  it('maps developer override to Pro without altering the underlying licensed tier', () => {
    expect(getEffectiveEntitlementTier('free', true)).toBe('pro');
    expect(getEffectiveEntitlementTier('plus', true)).toBe('pro');
    expect(getEffectiveEntitlementTier('free', false)).toBe('free');
    expect(getEffectiveEntitlementTier('plus', false)).toBe('plus');
  });

  it('keeps client frontend entitlements in exact sync with main process rules', () => {
    const tiers: SubscriptionTier[] = ['free', 'plus', 'pro'];
    for (const tier of tiers) {
      const serverEnt = getEntitlements(tier);
      const clientEnt = getClientEntitlements(tier);
      expect(clientEnt).toEqual(serverEnt);

      expect(isClientModeAllowed(tier, 'copilot')).toBe(isModeAllowed(tier, 'copilot'));
      expect(isClientModeAllowed(tier, 'interview')).toBe(isModeAllowed(tier, 'interview'));

      expect(canClientUseByokProvider(tier, 'gemini')).toBe(canUseByokProvider(tier, 'gemini'));
      expect(canClientUseByokProvider(tier, 'openai')).toBe(canUseByokProvider(tier, 'openai'));
    }
  });
});
