/**
 * Centralized AI Model & Provider Registry
 *
 * Single source of truth consumed by the Settings UI (Dashboard), main-process IPC router,
 * state migration, WebBridge, and provider HTTP adapters so UI options and API identifiers
 * cannot drift apart.
 *
 * All cloud model identifiers are verified against official provider documentation
 * (Google AI Gemini API, OpenAI API, Anthropic Claude API) as of 2026-11-18.
 */

export type AiProviderId = 'gemini' | 'openai' | 'anthropic' | 'ollama';

export interface ModelDefinition {
  /** Exact API model identifier transmitted to the provider endpoint. */
  readonly id: string;
  /** Human-readable label shown in the UI (never sent as the API model ID). */
  readonly displayName: string;
  /** Target provider responsible for serving this model. */
  readonly provider: AiProviderId;
  /** Whether the model supports image / screenshot input. */
  readonly supportsVision: boolean;
  /** Optional guidance shown alongside the model name. */
  readonly recommended?: boolean;
  /** True for legacy pinned snapshots retained for backward compatibility. */
  readonly legacy?: boolean;
}

export const MODEL_REGISTRY: readonly ModelDefinition[] = [
  // Google Gemini (official Gemini API IDs on ai.google.dev)
  {
    id: 'gemini-3.5-flash-lite',
    displayName: 'Google Gemini 3.5 Flash-Lite (Sub-second <1s Latency - Recommended)',
    provider: 'gemini',
    supportsVision: true,
    recommended: true,
  },
  {
    id: 'gemini-3.6-flash',
    displayName: 'Google Gemini 3.6 Flash (Fast Multimodal)',
    provider: 'gemini',
    supportsVision: true,
  },
  {
    id: 'gemini-3.8-flash',
    displayName: 'Google Gemini 3.8 Flash (Deep Multimodal)',
    provider: 'gemini',
    supportsVision: true,
  },
  {
    id: 'gemini-4-hydrogen',
    displayName: 'Google Gemini 4 Hydrogen (Fast General-Purpose Frontier)',
    provider: 'gemini',
    supportsVision: true,
  },
  {
    id: 'gemini-4-argon',
    displayName: 'Google Gemini 4 Argon (Efficient Frontier Reasoning)',
    provider: 'gemini',
    supportsVision: true,
  },
  {
    id: 'gemini-4-carbon',
    displayName: 'Google Gemini 4 Carbon (Strongest Frontier Reasoning)',
    provider: 'gemini',
    supportsVision: true,
  },
  {
    id: 'gemini-3.1-pro-preview',
    displayName: 'Google Gemini 3.1 Pro Preview (Deep Complex Reasoning)',
    provider: 'gemini',
    supportsVision: true,
  },

  // OpenAI (official OpenAI API IDs on platform.openai.com)
  {
    id: 'gpt-4o',
    displayName: 'OpenAI GPT-4o (Multimodal Vision)',
    provider: 'openai',
    supportsVision: true,
  },
  {
    id: 'gpt-4o-mini',
    displayName: 'OpenAI GPT-4o Mini (Fast & Cost Efficient)',
    provider: 'openai',
    supportsVision: true,
  },
  {
    id: 'gpt-4.1',
    displayName: 'OpenAI GPT-4.1 (1M Context Coding & Instruction)',
    provider: 'openai',
    supportsVision: true,
  },
  {
    id: 'gpt-4.1-mini',
    displayName: 'OpenAI GPT-4.1 Mini (Fast 1M Context)',
    provider: 'openai',
    supportsVision: true,
  },

  // Anthropic Claude (official Claude API dateless/snapshot IDs on claude.com / docs.anthropic.com)
  {
    id: 'claude-sonnet-5-5',
    displayName: 'Anthropic Claude Sonnet 5.5 (Recommended Balanced Claude)',
    provider: 'anthropic',
    supportsVision: true,
    recommended: true,
  },
  {
    id: 'claude-haiku-5-5',
    displayName: 'Anthropic Claude Haiku 5.5 (Fastest / Low Latency)',
    provider: 'anthropic',
    supportsVision: true,
  },
  {
    id: 'claude-opus-5-5',
    displayName: 'Anthropic Claude Opus 5.5 (Complex Agentic Coding)',
    provider: 'anthropic',
    supportsVision: true,
  },
  {
    id: 'claude-fable-5-2',
    displayName: 'Anthropic Claude Fable 5.2 (Deep Reasoning & Long-Horizon)',
    provider: 'anthropic',
    supportsVision: true,
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Anthropic Claude Sonnet 5 (Legacy Snapshot)',
    provider: 'anthropic',
    supportsVision: true,
    legacy: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Anthropic Claude Haiku 4.5 (Legacy Snapshot)',
    provider: 'anthropic',
    supportsVision: true,
    legacy: true,
  },
  {
    id: 'claude-opus-5',
    displayName: 'Anthropic Claude Opus 5 (Legacy Snapshot)',
    provider: 'anthropic',
    supportsVision: true,
    legacy: true,
  },

  // Local Offline Inference (Ollama on localhost:11434)
  {
    id: 'ollama',
    displayName: 'Local Ollama (Offline - localhost:11434)',
    provider: 'ollama',
    supportsVision: true,
    recommended: true,
  },
] as const;

export const DEFAULT_MODELS_BY_PROVIDER: Record<AiProviderId, string> = {
  gemini: 'gemini-3.5-flash-lite',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-5-5',
  ollama: 'ollama',
};

export const LEGACY_MODEL_MIGRATIONS: Record<string, ActiveModelId> = {
  'gemini-2.0-flash': 'gemini-3.5-flash-lite',
  'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-2.5-flash': 'gemini-3.5-flash-lite',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
};

export type ActiveModelId = (typeof MODEL_REGISTRY)[number]['id'];

const MODEL_MAP = new Map<string, ModelDefinition>(
  MODEL_REGISTRY.map(entry => [entry.id, entry])
);

const SAFE_MODEL_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/;

export function getModelDefinition(modelId: string | undefined | null): ModelDefinition | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  return MODEL_MAP.get(modelId.trim());
}

export function isRegisteredModel(modelId: string | undefined | null): modelId is ActiveModelId {
  return Boolean(getModelDefinition(modelId));
}

export function normalizeLegacyModelId(modelId: string | undefined | null): string | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const trimmed = modelId.trim();
  return LEGACY_MODEL_MIGRATIONS[trimmed] || trimmed;
}

/**
 * Resolves the target AI provider for a given model identifier.
 * Returns null if the model string is malformed or does not match any supported provider.
 */
export function resolveProviderForModel(modelId: string | undefined | null): AiProviderId | null {
  if (!modelId || typeof modelId !== 'string') return null;
  const trimmed = modelId.trim();
  if (!SAFE_MODEL_ID_REGEX.test(trimmed)) return null;

  const registered = MODEL_MAP.get(trimmed);
  if (registered) return registered.provider;

  if (trimmed === 'ollama' || trimmed.startsWith('ollama:') || trimmed.includes(':')) {
    return 'ollama';
  }
  if (trimmed.startsWith('gemini-')) return 'gemini';
  if (trimmed.startsWith('gpt-') || trimmed.startsWith('o1-') || trimmed.startsWith('o3-') || trimmed.startsWith('o4-')) {
    return 'openai';
  }
  if (trimmed.startsWith('claude-')) return 'anthropic';

  // Local Ollama catalog bare names (e.g., llama3.2, llava, moondream)
  if (/^(llama|llava|moondream|qwen|mistral|phi|gemma|deepseek|codellama)/i.test(trimmed)) {
    return 'ollama';
  }

  return null;
}

/**
 * Validates that the supplied model ID is syntactically valid and belongs to the expected provider.
 */
export function assertModelCompatibleWithProvider(
  modelId: string | undefined | null,
  expectedProvider: AiProviderId
): string {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  if (!raw) {
    return DEFAULT_MODELS_BY_PROVIDER[expectedProvider];
  }
  if (!SAFE_MODEL_ID_REGEX.test(raw)) {
    throw new Error(`Invalid ${expectedProvider} model identifier: "${raw.slice(0, 64)}"`);
  }
  const resolved = resolveProviderForModel(raw);
  if (resolved !== expectedProvider) {
    throw new Error(
      `Model "${raw}" is not compatible with provider "${expectedProvider}". Please select a valid ${expectedProvider} model in Settings.`
    );
  }
  return raw;
}
