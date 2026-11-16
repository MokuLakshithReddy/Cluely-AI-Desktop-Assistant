import {
  DesktopBridge,
  SharedState,
  SessionRecord,
  SessionSummary,
  Role,
} from './types';
import {
  streamGemini,
  streamOpenAI,
  streamClaude,
  streamOllama,
  transcribeAudio,
} from './providers';
import {
  inspectAndSanitizeOutboundPayload,
  sanitizeScreenshot,
} from './redaction';

// Sessions storage key (non-secret session summaries & notes)
const SESSIONS_STORAGE_KEY = 'scandium_past_sessions';
const LEGACY_SESSIONS_STORAGE_KEY = 'cluely_past_sessions';
const SHARED_STATE_STORAGE_KEY = 'scandium_shared_state';
const LEGACY_SHARED_STATE_STORAGE_KEY = 'cluely_shared_state';

// Ephemeral IN-MEMORY vault keys for Web Mode.
// Secrets are NEVER stored in unencrypted browser localStorage.
const inMemoryVaultKeys: Record<string, string> = {};

// In-flight request cancellation controllers
const activeWebControllers: Map<string, AbortController> = new Map();

class WebBridgeEventEmitter {
  private listeners: Map<string, Set<Function>> = new Map();

  on(event: string, fn: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(fn);
    return () => this.off(event, fn);
  }

  off(event: string, fn: Function) {
    this.listeners.get(event)?.delete(fn);
  }

  emit(event: string, ...args: any[]) {
    this.listeners.get(event)?.forEach(fn => {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[WebBridgeEventEmitter] Error in listener for ${event}:`, err);
      }
    });
  }
}

export const webBridgeEvents = new WebBridgeEventEmitter();

function getStoredSessions(): SessionRecord[] {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setStoredSessions(sessions: SessionRecord[]): void {
  try {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch (err) {
    console.error('[WebBridge] Failed to persist sessions:', err);
  }
}

const DEFAULT_WEB_STATE: SharedState = {
  appVersion: '1.0.2',
  isControlWindowLoaded: true,
  isChatWindowLoaded: true,
  isDashboardWindowLoaded: false,
  showChat: true,
  showDashboard: false,
  chatWindowIsExpanded: true,
  isStealthMode: false,
  meHasVoiceActivity: false,
  themHasVoiceActivity: false,
  isCapturingScreenshot: false,
  isRecording: false,
  microphoneCaptureStatus: 'idle',
  systemAudioCaptureStatus: 'idle',
  captureWarning: null,
  isPurging: false,
  isEmergencyStopping: false,
  micActive: false,
  systemAudioActive: false,
  privacyMode: 'local',
  meetingConsent: 'prompt',
  telemetryEnabled: false,
  enterpriseMode: false,
  redactSensitiveData: true,
  blockOutboundSecrets: false,
  encryptedStorageEnabled: true,
  activeMode: 'copilot',
  activeModel: 'ollama',
  hasApiKeys: {
    gemini: false,
    openai: false,
    anthropic: false,
    groq: false,
    ollama: true,
  },
  shortcuts: {
    toggleVisibility: 'CommandOrControl+Shift+Space',
    ask: 'CommandOrControl+Enter',
    clear: 'Escape',
    emergencyStop: 'CommandOrControl+Shift+Escape',
    toggleSession: 'CommandOrControl+Shift+X',
    moveUp: 'CommandOrControl+Up',
    moveDown: 'CommandOrControl+Down',
    moveLeft: 'CommandOrControl+Left',
    moveRight: 'CommandOrControl+Right',
  },
  session: null,
  knowledgeDocs: [],
};

export function initWebBridge(defaultState?: Partial<SharedState>): DesktopBridge {
  const initialHasKeys = {
    gemini: !!inMemoryVaultKeys.gemini,
    openai: !!inMemoryVaultKeys.openai,
    anthropic: !!inMemoryVaultKeys.anthropic,
    groq: !!inMemoryVaultKeys.groq,
    ollama: true,
  };

  let currentState: SharedState = {
    ...DEFAULT_WEB_STATE,
    ...defaultState,
    hasApiKeys: initialHasKeys,
  };

  try {
    const savedState = localStorage.getItem(SHARED_STATE_STORAGE_KEY);
    if (savedState) {
      const parsed = JSON.parse(savedState);
      currentState = {
        ...currentState,
        ...parsed,
        isRecording: false,
        meHasVoiceActivity: false,
        themHasVoiceActivity: false,
        hasApiKeys: initialHasKeys,
      };
    }
  } catch {}

  // Global browser keyboard shortcuts
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      webBridgeEvents.emit('shortcut-action', 'ask');
    } else if (e.key === 'Escape') {
      webBridgeEvents.emit('shortcut-action', 'clear');
    }
  });

  const bridge: DesktopBridge = {
    getSharedState: async () => {
      return currentState;
    },

    patchSharedState: async (patch: Partial<SharedState>) => {
      if (patch.enterpriseMode === true || currentState.enterpriseMode) {
        patch.privacyMode = 'local';
        patch.telemetryEnabled = false;
        if (patch.activeModel && patch.activeModel !== 'ollama') {
          patch.activeModel = 'ollama';
        }
      }
      currentState = { ...currentState, ...patch };
      try {
        localStorage.setItem(
          SHARED_STATE_STORAGE_KEY,
          JSON.stringify({
            activeMode: currentState.activeMode,
            activeModel: currentState.activeModel,
            isStealthMode: currentState.isStealthMode,
            knowledgeDocs: currentState.knowledgeDocs,
            privacyMode: currentState.privacyMode,
            meetingConsent: currentState.meetingConsent,
            telemetryEnabled: currentState.telemetryEnabled,
            enterpriseMode: currentState.enterpriseMode,
          })
        );
      } catch {}
      webBridgeEvents.emit('shared-state-updated', currentState);
      return currentState;
    },

    captureScreenshot: async () => {
      // Real browser screen capture via getDisplayMedia
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        throw new Error('Screen capture is not supported in this browser environment');
      }

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'browser' },
          audio: false,
        });

        const track = stream.getVideoTracks()[0];
        if (!track) {
          throw new Error('No video track available from screen capture');
        }

        const imageCapture = (window as any).ImageCapture
          ? new (window as any).ImageCapture(track)
          : null;

        if (imageCapture) {
          const bitmap = await imageCapture.grabFrame();
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(bitmap.width, 1920);
          canvas.height = Math.round((canvas.width / bitmap.width) * bitmap.height);
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/png');
          const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
          return {
            data: base64,
            contentType: 'image/png',
            width: canvas.width,
            height: canvas.height,
          };
        }

        // Fallback using HTML video element capture
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();

        const canvas = document.createElement('canvas');
        canvas.width = Math.min(video.videoWidth || 1920, 1920);
        canvas.height = Math.round((canvas.width / (video.videoWidth || 1920)) * (video.videoHeight || 1080));
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
        video.pause();
        video.srcObject = null;

        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        return {
          data: base64,
          contentType: 'image/png',
          width: canvas.width,
          height: canvas.height,
        };
      } catch (err: any) {
        throw new Error(`Screen capture permission denied or unavailable: ${err?.message || err}`);
      } finally {
        // ALWAYS cleanly stop all acquired screen capture tracks
        if (stream) {
          stream.getTracks().forEach(t => t.stop());
        }
      }
    },

    startListening: async () => {
      await bridge.patchSharedState({ isRecording: true });
    },

    stopListening: async () => {
      await bridge.patchSharedState({ isRecording: false });
    },

    toggleStealthMode: async (enable: boolean) => {
      await bridge.patchSharedState({ isStealthMode: enable });
      return enable;
    },

    dragControlWindow: () => {},
    dragControlWindowEnd: () => {},
    resizeChatWindow: () => {},
    minimizeApp: () => {
      console.log('[WebBridge] minimizeApp called');
    },
    quitApp: () => {
      console.log('[WebBridge] quitApp called');
      if (typeof window !== 'undefined' && window.confirm('Exit Scandium?')) {
        window.close();
      }
    },

    openDashboard: (tab?: string) => {
      window.location.hash = tab ? `dashboard?tab=${tab}` : 'dashboard';
      if (tab) {
        window.dispatchEvent(new CustomEvent('scandium-dashboard-tab', { detail: tab }));
        window.dispatchEvent(new CustomEvent('cluely-dashboard-tab', { detail: tab }));
      }
    },

    saveApiKey: async (provider: string, key: string) => {
      if (!provider || typeof provider !== 'string') throw new Error('Invalid provider');
      if (!key || typeof key !== 'string') throw new Error('Invalid API key');

      // In Web Mode, store keys STRICTLY in ephemeral memory
      inMemoryVaultKeys[provider] = key.trim();

      const hasKeys = {
        ...currentState.hasApiKeys,
        [provider]: true,
      };
      await bridge.patchSharedState({ hasApiKeys: hasKeys });
    },

    deleteApiKey: async (provider: string) => {
      delete inMemoryVaultKeys[provider];

      const hasKeys = {
        ...currentState.hasApiKeys,
        [provider]: false,
      };
      await bridge.patchSharedState({ hasApiKeys: hasKeys });
    },

    getHasApiKeys: async () => {
      return {
        gemini: !!inMemoryVaultKeys.gemini,
        openai: !!inMemoryVaultKeys.openai,
        anthropic: !!inMemoryVaultKeys.anthropic,
        groq: !!inMemoryVaultKeys.groq,
        ollama: true,
      };
    },

    abortAiStream: async (requestId?: string) => {
      if (requestId) {
        const ctrl = activeWebControllers.get(requestId);
        if (ctrl) {
          ctrl.abort();
          activeWebControllers.delete(requestId);
          await bridge.patchSharedState({ isGenerating: activeWebControllers.size > 0 });
          return true;
        }
        return false;
      }
      for (const ctrl of activeWebControllers.values()) {
        ctrl.abort();
      }
      activeWebControllers.clear();
      await bridge.patchSharedState({ isGenerating: false });
      return true;
    },

    executeAiStream: async options => {
      const {
        model,
        mode,
        query,
        screenshotBase64,
        recentTranscript,
        knowledgePassages,
        conversationHistory,
        requestId,
      } = options;

      const reqId = requestId || `web_req_${Date.now()}`;
      const abortController = new AbortController();
      activeWebControllers.set(reqId, abortController);
      await bridge.patchSharedState({ isGenerating: true });

      try {
        let providerName = 'gemini';
        if (model.includes('gpt') || model.includes('openai')) providerName = 'openai';
        else if (model.includes('claude') || model.includes('anthropic')) providerName = 'anthropic';
        else if (model.includes('ollama')) providerName = 'ollama';

        // Local-Only Privacy Mode enforcement
        if (currentState.privacyMode === 'local' && providerName !== 'ollama') {
          throw new Error(
            `[Privacy Mode: LOCAL] Cloud AI requests to "${providerName}" are strictly blocked. In local privacy mode, only local inference (Ollama) is permitted.`
          );
        }

        // Outbound Data Inspection & Redaction Guard
        let cleanQuery = query;
        let cleanTranscript = recentTranscript;
        let cleanHistory = conversationHistory;
        let cleanPassages = knowledgePassages;
        let cleanScreenshot = screenshotBase64;

        if (currentState.redactSensitiveData || currentState.blockOutboundSecrets) {
          // Strict Outbound Redaction: when redactSensitiveData is active and transmitting to cloud AI,
          // fail closed because pixel-level OCR cannot yet verify arbitrary workspace regions across the screen.
          // Transmitting desktop screenshots to external cloud AI providers is strictly blocked under fail-closed policy.
          if (screenshotBase64 && providerName !== 'ollama') {
            if (currentState.redactSensitiveData) {
              throw new Error(
                `[Outbound Security Guard] Cloud screenshot transmission blocked: Sensitive-Content Redaction is enabled. Because pixel-level OCR cannot yet verify arbitrary workspace regions on screen, transmitting desktop captures to cloud provider "${providerName}" is prohibited under fail-closed privacy policy. Switch to Local Ollama for offline screen analysis or disable screenshot attachment.`
              );
            }
            if (currentState.blockOutboundSecrets) {
              throw new Error(
                `[Outbound Security Guard] Request blocked: Outbound secret blocking is active. Transmitting unredacted desktop screen captures to cloud AI provider "${providerName}" is prohibited when egress secrets guard is enabled. Switch to Local Ollama or disable Block Outbound Secrets.`
              );
            }
          }

          // For on-device local inference (Ollama), perform local screen band masking
          if (currentState.redactSensitiveData && screenshotBase64 && providerName === 'ollama') {
            try {
              const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
              const imgBuf = Buffer.from(base64Data, 'base64');
              const { sanitizedBuffer, isRedacted } = await sanitizeScreenshot(imgBuf);
              if (isRedacted && sanitizedBuffer && sanitizedBuffer.length > 0) {
                cleanScreenshot = `data:image/png;base64,${sanitizedBuffer.toString('base64')}`;
              }
            } catch (err) {
              console.warn('[WebBridge] Failed to visually redact local screenshot for Ollama:', err);
            }
          }

          const inspection = inspectAndSanitizeOutboundPayload(
            {
              query,
              screenshotBase64: cleanScreenshot,
              recentTranscript,
              conversationHistory,
              knowledgePassages,
            },
            { blockOnSecrets: currentState.blockOutboundSecrets }
          );

          if (inspection.blocked) {
            throw new Error(
              `[Outbound Security Guard] Request blocked: Outbound prompt payload contains sensitive credentials (${inspection.detections.join(', ')}).`
            );
          }

          cleanQuery = inspection.sanitizedPayload.query || cleanQuery;
          cleanTranscript = inspection.sanitizedPayload.recentTranscript || cleanTranscript;
          cleanHistory = inspection.sanitizedPayload.conversationHistory || cleanHistory;
          cleanPassages = inspection.sanitizedPayload.knowledgePassages || cleanPassages;
          cleanScreenshot = inspection.sanitizedPayload.screenshotBase64 || cleanScreenshot;
        }

        const apiKey = inMemoryVaultKeys[providerName];

        const onToken = (token: string) => {
          webBridgeEvents.emit('ai-token-stream', token);
        };

        if (!apiKey && providerName !== 'ollama') {
          const demoResponse =
            `**Scandium (${mode.toUpperCase()} Mode)**\n\n` +
            `• **Screen Context**: ${cleanScreenshot ? 'Visible screenshot analyzed' : 'No screen attached'}\n` +
            `• **Conversation Context**: ${cleanTranscript.length} live speech items referenced\n` +
            `• **Grounded Knowledge**: ${cleanPassages?.length || 0} reference passages retrieved\n\n` +
            `> **Notice**: Configure your **${providerName.toUpperCase()} API Key** in Settings (held in ephemeral session memory) to enable live model reasoning!`;

          let streamed = '';
          for (const char of demoResponse) {
            if (abortController.signal.aborted) break;
            streamed += char;
            onToken(char);
            await new Promise(r => setTimeout(r, 10));
          }
          return { content: streamed, sources: cleanPassages };
        }

        let content = '';
        if (providerName === 'gemini') {
          content = await streamGemini({
            model,
            apiKey,
            mode,
            query: cleanQuery,
            screenshotBase64: cleanScreenshot,
            recentTranscript: cleanTranscript,
            knowledgePassages: cleanPassages,
            conversationHistory: cleanHistory,
            signal: abortController.signal,
            onToken,
          });
        } else if (providerName === 'openai') {
          content = await streamOpenAI({
            model,
            apiKey,
            mode,
            query: cleanQuery,
            screenshotBase64: cleanScreenshot,
            recentTranscript: cleanTranscript,
            knowledgePassages: cleanPassages,
            conversationHistory: cleanHistory,
            signal: abortController.signal,
            onToken,
          });
        } else if (providerName === 'anthropic') {
          content = await streamClaude({
            model,
            apiKey,
            mode,
            query: cleanQuery,
            screenshotBase64: cleanScreenshot,
            recentTranscript: cleanTranscript,
            knowledgePassages: cleanPassages,
            conversationHistory: cleanHistory,
            signal: abortController.signal,
            onToken,
          });
        } else if (providerName === 'ollama') {
          content = await streamOllama({
            model,
            mode,
            query: cleanQuery,
            screenshotBase64: cleanScreenshot,
            recentTranscript: cleanTranscript,
            knowledgePassages: cleanPassages,
            conversationHistory: cleanHistory,
            signal: abortController.signal,
            onToken,
          });
        }

        return { content, sources: cleanPassages };
      } finally {
        activeWebControllers.delete(reqId);
        await bridge.patchSharedState({ isGenerating: activeWebControllers.size > 0 });
      }
    },

    transcribeAudioPayload: async ({ wavBase64, language }) => {
      if (currentState.privacyMode === 'local') {
        throw new Error(
          '[Privacy Mode: LOCAL] Cloud audio transcription is blocked. Audio processing remains strictly on-device.'
        );
      }

      const groqKey = inMemoryVaultKeys['groq'];
      const openaiKey = inMemoryVaultKeys['openai'];

      if (!groqKey && !openaiKey) {
        throw new Error('No STT API key configured. Please enter a Groq or OpenAI key in Settings.');
      }

      const binaryString = atob(wavBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const provider = groqKey ? 'groq' : 'openai';
      const activeKey = groqKey || openaiKey;
      const text = await transcribeAudio(bytes.buffer, activeKey, provider, language || 'en');

      return { text };
    },

    saveSessionRecord: async (session: SessionRecord) => {
      if (currentState.enterpriseMode) {
        // In Enterprise Mode, disk/localStorage session history is disabled
        return;
      }
      const existing = getStoredSessions();
      // Strip screenshot base64 before saving to prevent megabytes of persistent data
      const sanitizedSession: SessionRecord = {
        ...session,
        updatedAt: new Date().toISOString(),
        messages: (session.messages || []).map(m => {
          const { screenshot, ...rest } = m;
          return rest;
        }),
      };

      const updated = [
        sanitizedSession,
        ...existing.filter(s => s.id !== sanitizedSession.id),
      ];
      setStoredSessions(updated);
    },

    getPastSession: async (id: string) => {
      const existing = getStoredSessions();
      return existing.find(s => s.id === id) || null;
    },

    listPastSessions: async () => {
      const existing = getStoredSessions();
      return existing.map(s => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        durationSeconds: s.durationSeconds,
        mode: s.mode,
        transcriptCount: s.transcript?.length || 0,
        messageCount: s.messages?.length || 0,
      }));
    },

    deletePastSession: async (id: string) => {
      const existing = getStoredSessions();
      const filtered = existing.filter(s => s.id !== id);
      setStoredSessions(filtered);
      return true;
    },

    purgeAllPastSessions: async () => {
      setStoredSessions([]);
    },

    getHardwareProfile: async () => ({
      os: 'Web Runtime',
      platform: 'browser',
      arch: 'wasm',
      cpuModel: 'Host CPU',
      cpuCores: navigator.hardwareConcurrency || 4,
      totalRamMb: 16384,
      availableRamMb: 8192,
      totalDiskMb: 100000,
      freeDiskMb: 50000,
      gpus: [{ name: 'WebGPU Display', vendor: 'intel' }],
      primaryGpu: { name: 'WebGPU Display', vendor: 'intel' },
      isNvidiaCuda: false,
      isAppleSilicon: false,
      isIntelArc: true,
      recommendedTextModel: 'llama3.2:3b',
      recommendedVisionModel: 'llava:7b',
      recommendedSttModel: 'ggml-base.en',
      warnings: [],
    }),

    getOllamaStatus: async () => ({
      isRunning: false,
      endpoint: 'http://localhost:11434',
    }),

    listOllamaModels: async () => [],
    getOllamaCatalog: async () => [],
    pullOllamaModel: async () => {},
    deleteOllamaModel: async () => {},
    testOllamaGeneration: async () => ({ success: true, text: 'Scandium local AI engine is online and operational.', latencyMs: 24 }),

    getWhisperModels: async () => [
      { id: 'ggml-tiny.en', name: 'Whisper Tiny (English, ~75MB)', filename: 'ggml-tiny.en.bin', sizeBytes: 77705139, isDownloaded: true },
      { id: 'ggml-base.en', name: 'Whisper Base (English, ~142MB)', filename: 'ggml-base.en.bin', sizeBytes: 147964211, isDownloaded: false },
    ],
    downloadWhisperModel: async () => true,
    setActiveWhisperModel: async () => {},

    getLicenseStatus: async () => ({
      hasLicense: false,
      tier: 'free',
      status: 'none',
      instanceName: 'Scandium-Web',
    }),
    activateLicense: async (key: string) => ({
      licenseKey: key,
      instanceId: 'web-inst-1',
      instanceName: 'Scandium-Web',
      status: 'active',
      tier: 'plus',
      activationLimit: 2,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now(),
    }),
    validateLicense: async () => null,
    deactivateLicense: async () => {},

    purgeAllData: async () => {
      setStoredSessions([]);
      // Clear in-memory keys
      for (const k of Object.keys(inMemoryVaultKeys)) {
        delete inMemoryVaultKeys[k];
      }
      localStorage.removeItem(SHARED_STATE_STORAGE_KEY);
      localStorage.removeItem(LEGACY_SHARED_STATE_STORAGE_KEY);
      localStorage.removeItem(LEGACY_SESSIONS_STORAGE_KEY);
      await bridge.patchSharedState({
        session: null,
        knowledgeDocs: [],
        hasApiKeys: {
          gemini: false,
          openai: false,
          anthropic: false,
          groq: false,
          ollama: true,
        },
      });
    },

    onAiTokenStream: (callback: (token: string) => void) => {
      return webBridgeEvents.on('ai-token-stream', callback);
    },

    onSharedStateUpdated: (callback: (state: SharedState) => void) => {
      return webBridgeEvents.on('shared-state-updated', callback);
    },

    onShortcutAction: (callback: (action: string) => void) => {
      return webBridgeEvents.on('shortcut-action', callback);
    },

    onAudioChunk: (callback: (data: { role: Role; chunk: ArrayBuffer }) => void) => {
      return webBridgeEvents.on('audio-data', callback);
    },

    onDashboardSwitchTab: (callback: (tab: string) => void) => {
      return webBridgeEvents.on('dashboard-switch-tab', callback);
    },
  };

  return bridge;
}
