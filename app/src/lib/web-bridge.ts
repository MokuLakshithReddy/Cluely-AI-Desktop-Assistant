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

const VAULT_STORAGE_KEY = 'cluely_vault_keys';
const SESSIONS_STORAGE_KEY = 'cluely_past_sessions';
const SHARED_STATE_STORAGE_KEY = 'cluely_shared_state';

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

function getStoredVaultKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setStoredVaultKeys(keys: Record<string, string>): void {
  try {
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(keys));
  } catch (err) {
    console.error('[WebBridge] Failed to persist vault keys:', err);
  }
}

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
  const vaultKeys = getStoredVaultKeys();

  // Update hasApiKeys in state
  const initialHasKeys = {
    gemini: !!vaultKeys.gemini,
    openai: !!vaultKeys.openai,
    anthropic: !!vaultKeys.anthropic,
    groq: !!vaultKeys.groq,
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

  // Set up global keyboard shortcuts in browser
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
      try {
        // Try browser screen capture if supported and permitted
        if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
          try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
              video: { displaySurface: 'browser' },
              audio: false,
            });
            const track = stream.getVideoTracks()[0];
            const imageCapture = (window as any).ImageCapture
              ? new (window as any).ImageCapture(track)
              : null;

            if (imageCapture) {
              const bitmap = await imageCapture.grabFrame();
              track.stop();
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
            track.stop();
          } catch {
            // Dismissed or blocked by iframe permissions, fall back to canvas screenshot
          }
        }

        // Generate synthetic context snapshot
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, 1280, 720);

        ctx.fillStyle = '#1e293b';
        ctx.fillRect(40, 40, 1200, 640);

        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 24px -apple-system, sans-serif';
        ctx.fillText('Cluely AI Desktop Copilot — Active Workspace Context', 70, 90);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '16px monospace';
        ctx.fillText(`Timestamp: ${new Date().toISOString()}`, 70, 130);
        ctx.fillText(`Active Mode: ${currentState.activeMode.toUpperCase()}`, 70, 160);
        ctx.fillText(`Selected Model: ${currentState.activeModel}`, 70, 190);
        ctx.fillText(`Active Transcripts: ${currentState.session?.transcript.length || 0}`, 70, 220);
        ctx.fillText(`Knowledge Documents: ${currentState.knowledgeDocs.length}`, 70, 250);

        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        return {
          data: base64,
          contentType: 'image/png',
          width: 1280,
          height: 720,
        };
      } catch (err) {
        console.warn('[WebBridge] Screen capture error:', err);
        return { data: '', contentType: 'image/png', width: 0, height: 0 };
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
      window.location.hash = 'dashboard';
      if (tab) {
        window.dispatchEvent(new CustomEvent('cluely-dashboard-tab', { detail: tab }));
      }
    },

    saveApiKey: async (provider: string, key: string) => {
      const keys = getStoredVaultKeys();
      keys[provider] = key;
      setStoredVaultKeys(keys);

      const hasKeys = {
        ...currentState.hasApiKeys,
        [provider]: true,
      };
      await bridge.patchSharedState({ hasApiKeys: hasKeys });
    },

    deleteApiKey: async (provider: string) => {
      const keys = getStoredVaultKeys();
      delete keys[provider];
      setStoredVaultKeys(keys);

      const hasKeys = {
        ...currentState.hasApiKeys,
        [provider]: false,
      };
      await bridge.patchSharedState({ hasApiKeys: hasKeys });
    },

    getHasApiKeys: async () => {
      const keys = getStoredVaultKeys();
      return {
        gemini: !!keys.gemini,
        openai: !!keys.openai,
        anthropic: !!keys.anthropic,
        groq: !!keys.groq,
        ollama: true,
      };
    },

    executeAiStream: async options => {
      const { model, mode, query, screenshotBase64, recentTranscript, knowledgePassages } = options;
      const keys = getStoredVaultKeys();

      let providerName = 'gemini';
      if (model.includes('gpt') || model.includes('openai')) providerName = 'openai';
      else if (model.includes('claude') || model.includes('anthropic')) providerName = 'anthropic';
      else if (model.includes('ollama')) providerName = 'ollama';

      const apiKey = keys[providerName];

      const onToken = (token: string) => {
        webBridgeEvents.emit('ai-token-stream', token);
      };

      if (!apiKey && providerName !== 'ollama') {
        const demoResponse = `**Cluely Copilot (${mode.toUpperCase()} Mode)**\n\n` +
          `• **Screen Context**: ${screenshotBase64 ? 'Visible screenshot analyzed' : 'No screen attached'}\n` +
          `• **Conversation Context**: ${recentTranscript.length} live speech items referenced\n` +
          `• **Grounded Knowledge**: ${knowledgePassages?.length || 0} reference passages retrieved\n\n` +
          `> **Tip**: Configure your **${providerName.toUpperCase()} API Key** in Settings (Vault) to enable live model reasoning!`;

        let streamed = '';
        for (const char of demoResponse) {
          streamed += char;
          onToken(char);
          await new Promise(r => setTimeout(r, 10));
        }
        return { content: demoResponse, sources: knowledgePassages };
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
          onToken,
        });
      }

      return { content, sources: knowledgePassages };
    },

    transcribeAudioPayload: async ({ wavBase64, language }) => {
      const keys = getStoredVaultKeys();
      const groqKey = keys.groq;
      const openaiKey = keys.openai;
      const activeKey = groqKey || openaiKey;
      const provider = groqKey ? 'groq' : 'openai';

      if (!activeKey) {
        throw new Error('No Speech-to-Text key configured. Set Groq or OpenAI key in Settings.');
      }

      const binaryStr = atob(wavBase64);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const text = await transcribeAudio(bytes.buffer, activeKey, provider, language || 'en');
      return { text };
    },

    saveSessionRecord: async (session: SessionRecord) => {
      const sessions = getStoredSessions();
      const idx = sessions.findIndex(s => s.id === session.id);
      if (idx >= 0) {
        sessions[idx] = session;
      } else {
        sessions.unshift(session);
      }
      setStoredSessions(sessions);
    },

    listPastSessions: async () => {
      const sessions = getStoredSessions();
      return sessions.map(s => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        durationSeconds: s.durationSeconds,
        mode: s.mode,
        transcriptCount: s.transcript.length,
        messageCount: s.messages.length,
      }));
    },

    getPastSession: async (id: string) => {
      const sessions = getStoredSessions();
      return sessions.find(s => s.id === id) || null;
    },

    deletePastSession: async (id: string) => {
      const sessions = getStoredSessions();
      const filtered = sessions.filter(s => s.id !== id);
      setStoredSessions(filtered);
      return true;
    },

    purgeAllPastSessions: async () => {
      setStoredSessions([]);
    },

    onSharedStateUpdated: callback => {
      return webBridgeEvents.on('shared-state-updated', callback);
    },

    onAudioChunk: callback => {
      return webBridgeEvents.on('audio-chunk', callback);
    },

    onShortcutAction: callback => {
      return webBridgeEvents.on('shortcut-action', callback);
    },

    onAiTokenStream: callback => {
      return webBridgeEvents.on('ai-token-stream', callback);
    },
  };

  return bridge;
}
