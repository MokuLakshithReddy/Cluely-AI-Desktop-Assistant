import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { SharedState } from '../../src/lib/types';
import { credentialVault } from '../services/vault';

function getStateFile(): string {
  try {
    return path.join(app.getPath('userData'), 'cluely-shared-state.json');
  } catch {
    return path.join(process.cwd(), 'cluely-shared-state.json');
  }
}

export const INITIAL_STATE: SharedState = {
  appVersion: '1.0.0',
  isControlWindowLoaded: false,
  isChatWindowLoaded: false,
  isDashboardWindowLoaded: false,
  showChat: true,
  showDashboard: false,
  chatWindowIsExpanded: true,
  isStealthMode: true, // Content protection enabled by default
  meHasVoiceActivity: false,
  themHasVoiceActivity: false,
  isCapturingScreenshot: false,
  isRecording: false,
  activeMode: 'copilot',
  activeModel: 'gemini-2.5-flash',
  hasApiKeys: {
    gemini: false,
    openai: false,
    anthropic: false,
    groq: false,
    ollama: false,
  },
  shortcuts: {
    toggleVisibility: 'CommandOrControl+Shift+Space',
    ask: 'CommandOrControl+Enter',
    clear: 'Escape',
    toggleSession: 'CommandOrControl+Shift+X',
    moveUp: 'CommandOrControl+Up',
    moveDown: 'CommandOrControl+Down',
    moveLeft: 'CommandOrControl+Left',
    moveRight: 'CommandOrControl+Right',
  },
  session: null,
  knowledgeDocs: [],
};

class StateManager {
  private state: SharedState = { ...INITIAL_STATE };
  private listeners: ((state: SharedState) => void)[] = [];

  constructor() {
    this.load();
    this.syncVaultKeys();
  }

  public async syncVaultKeys() {
    try {
      const keys = await credentialVault.hasKeys();
      this.patchState({
        hasApiKeys: {
          gemini: !!keys.gemini,
          openai: !!keys.openai,
          anthropic: !!keys.anthropic,
          groq: !!keys.groq,
          ollama: !!keys.ollama,
        },
      });
    } catch (e) {
      console.warn('[StateManager] Failed to sync keys from vault:', e);
    }
  }

  public getState(): SharedState {
    return { ...this.state };
  }

  public patchState(patch: Partial<SharedState>): SharedState {
    this.state = { ...this.state, ...patch };
    this.save();
    this.notify();
    return this.state;
  }

  public subscribe(listener: (state: SharedState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private load() {
    try {
      const stateFile = getStateFile();
      if (fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const parsed = JSON.parse(raw);

        // Sanitize: never allow plaintext apiKeys into state even if old file had them
        delete parsed.apiKeys;

        this.state = {
          ...INITIAL_STATE,
          appVersion: (app && typeof app.isReady === 'function' && app.isReady()) ? app.getVersion() : '1.0.0',
          ...parsed,
          isControlWindowLoaded: false,
          isChatWindowLoaded: false,
          isDashboardWindowLoaded: false,
          isRecording: false,
          meHasVoiceActivity: false,
          themHasVoiceActivity: false,
          isCapturingScreenshot: false,
        };
      }
    } catch (e) {
      console.error('[StateManager] Failed to load state:', e);
    }
  }

  private save() {
    try {
      const stateFile = getStateFile();
      const dir = path.dirname(stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Clean serialization copy: ensure no secrets are serialized
      const toSave: any = { ...this.state };
      delete toSave.apiKeys;

      fs.writeFileSync(stateFile, JSON.stringify(toSave, null, 2), 'utf8');
    } catch (e) {
      console.error('[StateManager] Failed to save state:', e);
    }
  }
}

export const stateManager = new StateManager();
