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

// Sessions storage key (non-secret session summaries & notes)
const SESSIONS_STORAGE_KEY = 'cluely_past_sessions';
const SHARED_STATE_STORAGE_KEY = 'cluely_shared_state';

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

export function initWebBridge(defaultState: SharedState): DesktopBridge {
  const initialHasKeys = {
    gemini: !!inMemoryVaultKeys.gemini,
    openai: !!inMemoryVaultKeys.openai,
    anthropic: !!inMemoryVaultKeys.anthropic,
    groq: !!inMemoryVaultKeys.groq,
    ollama: true,
  };

  let currentState: SharedState = {
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
      currentState = { ...currentState, ...patch };
      try {
        localStorage.setItem(
          SHARED_STATE_STORAGE_KEY,
          JSON.stringify({
            activeMode: currentState.activeMode,
            activeModel: currentState.activeModel,
            isStealthMode: currentState.isStealthMode,
            knowledgeDocs: currentState.knowledgeDocs,
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

    openDashboard: (tab?: string) => {
      window.location.hash = tab ? `dashboard?tab=${tab}` : 'dashboard';
      if (tab) {
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

        const apiKey = inMemoryVaultKeys[providerName];

        const onToken = (token: string) => {
          webBridgeEvents.emit('ai-token-stream', token);
        };

        if (!apiKey && providerName !== 'ollama') {
          const demoResponse =
            `**Cluely Copilot (${mode.toUpperCase()} Mode)**\n\n` +
            `• **Screen Context**: ${screenshotBase64 ? 'Visible screenshot analyzed' : 'No screen attached'}\n` +
            `• **Conversation Context**: ${recentTranscript.length} live speech items referenced\n` +
            `• **Grounded Knowledge**: ${knowledgePassages?.length || 0} reference passages retrieved\n\n` +
            `> **Notice**: Configure your **${providerName.toUpperCase()} API Key** in Settings (held in ephemeral session memory) to enable live model reasoning!`;

          let streamed = '';
          for (const char of demoResponse) {
            if (abortController.signal.aborted) break;
            streamed += char;
            onToken(char);
            await new Promise(r => setTimeout(r, 10));
          }
          return { content: streamed, sources: knowledgePassages };
        }

        let content = '';
        if (providerName === 'gemini') {
          content = await streamGemini({
            model,
            apiKey,
            mode,
            query,
            screenshotBase64,
            recentTranscript,
            knowledgePassages,
            conversationHistory,
            signal: abortController.signal,
            onToken,
          });
        } else if (providerName === 'openai') {
          content = await streamOpenAI({
            model,
            apiKey,
            mode,
            query,
            screenshotBase64,
            recentTranscript,
            knowledgePassages,
            conversationHistory,
            signal: abortController.signal,
            onToken,
          });
        } else if (providerName === 'anthropic') {
          content = await streamClaude({
            model,
            apiKey,
            mode,
            query,
            screenshotBase64,
            recentTranscript,
            knowledgePassages,
            conversationHistory,
            signal: abortController.signal,
            onToken,
          });
        } else if (providerName === 'ollama') {
          content = await streamOllama({
            model,
            mode,
            query,
            screenshotBase64,
            recentTranscript,
            knowledgePassages,
            conversationHistory,
            signal: abortController.signal,
            onToken,
          });
        }

        return { content, sources: knowledgePassages };
      } finally {
        activeWebControllers.delete(reqId);
        await bridge.patchSharedState({ isGenerating: activeWebControllers.size > 0 });
      }
    },

    transcribeAudioPayload: async ({ wavBase64, language }) => {
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

    purgeAllData: async () => {
      setStoredSessions([]);
      // Clear in-memory keys
      for (const k of Object.keys(inMemoryVaultKeys)) {
        delete inMemoryVaultKeys[k];
      }
      localStorage.removeItem(SHARED_STATE_STORAGE_KEY);
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
