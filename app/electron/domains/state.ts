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
  appVersion: '1.0.1',
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
  isPurging: false,
  activeMode: 'copilot',
  activeModel: 'gemini-3.8-flash',
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

export class StateManager {
  private state: SharedState = { ...INITIAL_STATE };
  private listeners: ((state: SharedState) => void)[] = [];
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor(private readonly stateFileOverride?: string, syncVaultOnStart: boolean = true) {
    this.load();
    if (syncVaultOnStart) this.syncVaultKeys();
  }

  private getStateFilePath(): string {
    return this.stateFileOverride || getStateFile();
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
    if ((patch.activeModel as any) === 'gemini-2.5-flash') {
      patch.activeModel = 'gemini-3.8-flash';
    } else if ((patch.activeModel as any) === 'gemini-3.1-pro') {
      patch.activeModel = 'gemini-3.1-pro-preview';
    }
    this.state = { ...this.state, ...patch };
    this.scheduleSave();
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

  private scheduleSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.flushSave();
    }, 200);
  }

  public flushSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.save();
  }

  /** Persist the current state synchronously and propagate failures to critical callers. */
  public flushSaveOrThrow(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.save(true);
  }

  private load() {
    try {
      const stateFile = this.getStateFilePath();
      if (fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const parsed = JSON.parse(raw);

        // Sanitize persisted state: credentials and transient diagnostics must never be restored.
        delete parsed.apiKeys;
        delete parsed.persistenceError;

        this.state = {
          ...INITIAL_STATE,
          appVersion: (app && typeof app.isReady === 'function' && app.isReady()) ? app.getVersion() : '1.0.1',
          ...parsed,
          isControlWindowLoaded: false,
          isChatWindowLoaded: false,
          isDashboardWindowLoaded: false,
          isRecording: false,
          isPurging: false,
          meHasVoiceActivity: false,
          themHasVoiceActivity: false,
          isCapturingScreenshot: false,
        };

        // Automatic migration from restricted legacy gemini-2.5-flash to flagship gemini-3.8-flash
        if ((this.state.activeModel as string) === 'gemini-2.5-flash' || !this.state.activeModel) {
          this.state.activeModel = 'gemini-3.8-flash';
        } else if ((this.state.activeModel as string) === 'gemini-3.1-pro') {
          this.state.activeModel = 'gemini-3.1-pro-preview';
        }
      }
    } catch (e) {
      console.error('[StateManager] Failed to load state:', e);
    }
  }

  private save(throwOnError: boolean = false) {
    try {
      const stateFile = this.getStateFilePath();
      const dir = path.dirname(stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Clean serialization copy: ensure no secrets or screenshot payloads are saved to disk
      const toSave: any = { ...this.state };
      delete toSave.apiKeys;
      // Persistence diagnostics are transient UI state and must never be stored in the file.
      delete toSave.persistenceError;

      if (toSave.session && Array.isArray(toSave.session.messages)) {
        toSave.session = {
          ...toSave.session,
          messages: toSave.session.messages.map((m: any) => {
            if (m.screenshot) {
              const { screenshot, ...rest } = m;
              return rest;
            }
            return m;
          }),
        };
      }

      fs.writeFileSync(stateFile, JSON.stringify(toSave, null, 2), 'utf8');
      if (this.state.persistenceError) {
        this.state = { ...this.state, persistenceError: null };
        this.notify();
      }
    } catch (e) {
      console.error('[StateManager] Failed to save state:', e);
      this.state = {
        ...this.state,
        persistenceError: 'Local state could not be saved. Check available disk space and file permissions.',
      };
      this.notify();
      if (throwOnError) throw e;
    }
  }
}

export const stateManager = new StateManager();
