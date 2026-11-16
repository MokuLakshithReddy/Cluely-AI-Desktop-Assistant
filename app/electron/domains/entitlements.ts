export type SubscriptionTier = 'free' | 'plus' | 'pro';

export interface TierEntitlements {
  tier: SubscriptionTier;
  label: string;
  maxDeviceSlots: number;
  allowedModes: string[];
  canUseLocalWhisper: boolean;
  canUseLocalVision: boolean;
  canUseCloudByok: boolean;
  allowedByokProviders: string[];
  canUseKnowledgeRag: boolean;
  maxKnowledgeDocuments: number;
}

export const TIER_ENTITLEMENTS: Record<SubscriptionTier, TierEntitlements> = {
  free: {
    tier: 'free',
    label: 'Scandium Free',
    maxDeviceSlots: 1,
    allowedModes: ['copilot'],
    canUseLocalWhisper: false,
    canUseLocalVision: false,
    canUseCloudByok: false,
    allowedByokProviders: [],
    canUseKnowledgeRag: false,
    maxKnowledgeDocuments: 0,
  },
  plus: {
    tier: 'plus',
    label: 'Scandium Plus',
    maxDeviceSlots: 2,
    allowedModes: ['copilot', 'coding', 'sales'],
    canUseLocalWhisper: true,
    canUseLocalVision: true,
    canUseCloudByok: true,
    allowedByokProviders: ['gemini', 'groq'],
    canUseKnowledgeRag: true,
    maxKnowledgeDocuments: 20,
  },
  pro: {
    tier: 'pro',
    label: 'Scandium Pro',
    maxDeviceSlots: 5,
    allowedModes: ['copilot', 'coding', 'sales', 'interview', 'executive'],
    canUseLocalWhisper: true,
    canUseLocalVision: true,
    canUseCloudByok: true,
    allowedByokProviders: ['gemini', 'openai', 'anthropic', 'groq'],
    canUseKnowledgeRag: true,
    maxKnowledgeDocuments: 100,
  },
};

export function getEntitlements(tier: SubscriptionTier): TierEntitlements {
  return TIER_ENTITLEMENTS[tier] || TIER_ENTITLEMENTS.free;
}

export function isModeAllowed(tier: SubscriptionTier, mode: string): boolean {
  const e = getEntitlements(tier);
  return e.allowedModes.includes(mode);
}

export function canUseByokProvider(tier: SubscriptionTier, provider: string): boolean {
  const e = getEntitlements(tier);
  return e.canUseCloudByok && (e.allowedByokProviders.includes(provider) || e.allowedByokProviders.includes('all'));
}
