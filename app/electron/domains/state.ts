import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { SharedState } from '../../src/lib/types';
import { credentialVault } from '../services/vault';
import { encryptStoragePayload, decryptStoragePayload } from '../services/storage-encryption';

function getApplicationVersion(): string {
  try {
    const version = app.getVersion();
    return typeof version === 'string' && version.trim() ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getStateFile(): string {
  try {
    return path.join(app.getPath('userData'), 'cluely-shared-state.json');
  } catch {
    return path.join(process.cwd(), 'cluely-shared-state.json');
  }
}

export const INITIAL_STATE: SharedState = {
  appVersion: getApplicationVersion(),
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
  microphoneCaptureStatus: 'idle',
  systemAudioCaptureStatus: 'idle',
  captureWarning: null,
  isPurging: false,
  isEmergencyStopping: false,
  micActive: false,
  systemAudioActive: false,
  privacyMode: (process.env.PRIVACY_MODE === 'LOCAL' || process.env.ENTERPRISE_MODE === 'true') ? 'local' : 'cloud',
  meetingConsent: process.env.SMOKE_TEST === 'true' ? 'always_allowed' : 'prompt',
  telemetryEnabled: false,
  enterpriseMode: process.env.ENTERPRISE_MODE === 'true',
  redactSensitiveData: true,
  blockOutboundSecrets: false,
  encryptedStorageEnabled: true,
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

export class StateManager {
  private state: SharedState = { ...INITIAL_STATE };
  private listeners: ((state: SharedState) => void)[] = [];
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor(private readonly stateFileOverride?: string, syncVaultOnStart: boolean = true) {
    try {
      this.load();
    } catch (e) {
      // Caught in constructor so instance is created, but state is guaranteed purged to INITIAL_STATE with persistenceError
    }
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

    // Enterprise Mode enforcement: strictly lock to local inference and disable telemetry
    if (patch.enterpriseMode === true || (this.state.enterpriseMode && patch.enterpriseMode !== false)) {
      patch.privacyMode = 'local';
      patch.telemetryEnabled = false;
      if (patch.activeModel && patch.activeModel !== 'ollama') {
        patch.activeModel = 'ollama';
      }
    } else if (patch.privacyMode === 'local' && patch.activeModel && patch.activeModel !== 'ollama') {
      patch.activeModel = 'ollama';
    }

    // Storage encryption is permanently enforced; plaintext serialization is impossible
    patch.encryptedStorageEnabled = true;

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
      if (
        typeof app !== 'undefined' &&
        typeof app.isReady === 'function' &&
        !app.isReady() &&
        process.env.VITEST !== 'true' &&
        process.env.TEST !== 'true'
      ) {
        return; // OS-backed safeStorage is only initialized after Electron app.whenReady() in live runtime
      }
      const stateFile = this.getStateFilePath();
      if (fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const decrypted = decryptStoragePayload(raw);
        const parsed = JSON.parse(decrypted);

        // Sanitize persisted state: credentials and transient diagnostics must never be restored.
        delete parsed.apiKeys;
        delete parsed.persistenceError;
        // Application version belongs to the packaged application, never to user state.
        delete parsed.appVersion;

        this.state = {
          ...INITIAL_STATE,
          ...parsed,
          encryptedStorageEnabled: true,
          appVersion: getApplicationVersion(),
          isControlWindowLoaded: false,
          isChatWindowLoaded: false,
          isDashboardWindowLoaded: false,
          isRecording: false,
          microphoneCaptureStatus: 'idle',
          systemAudioCaptureStatus: 'idle',
          captureWarning: null,
          isPurging: false,
          isEmergencyStopping: false,
          micActive: false,
          systemAudioActive: false,
          meHasVoiceActivity: false,
          themHasVoiceActivity: false,
          isCapturingScreenshot: false,
        };

        // Guarantee legacy migration: if the state file was unencrypted plaintext JSON, immediately rewrite encrypted
        if (!raw.startsWith('enc:v1:')) {
          try {
            this.save(true);
            console.log('[StateManager] Migrated legacy plaintext state file to AES-256-GCM encrypted storage.');
          } catch (migErr) {
            console.error('[StateManager] Failed to encrypt legacy state file on disk:', migErr);
            // FAIL-CLOSED: Immediately purge sensitive in-memory state
            this.state = {
              ...INITIAL_STATE,
              persistenceError: 'Fail-closed: Migration of legacy plaintext state to encrypted storage failed. In-memory state purged.',
            };
            throw new Error('[StateManager] Fail-closed: Migration of legacy plaintext state to encrypted storage failed.');
          }
        }

        // Automatic migration from restricted legacy gemini-2.5-flash to flagship gemini-3.8-flash
        if ((this.state.activeModel as string) === 'gemini-2.5-flash' || !this.state.activeModel) {
          this.state.activeModel = 'gemini-3.8-flash';
        } else if ((this.state.activeModel as string) === 'gemini-3.1-pro') {
          this.state.activeModel = 'gemini-3.1-pro-preview';
        }

        // Enterprise & Privacy Mode Environment Overrides
        if (process.env.ENTERPRISE_MODE === 'true' || this.state.enterpriseMode) {
          this.state.enterpriseMode = true;
          this.state.privacyMode = 'local';
          this.state.telemetryEnabled = false;
          this.state.activeModel = 'ollama';
        } else if (process.env.PRIVACY_MODE === 'LOCAL' || this.state.privacyMode === 'local') {
          this.state.privacyMode = 'local';
          if (!this.state.activeModel || this.state.activeModel !== 'ollama') {
            this.state.activeModel = 'ollama';
          }
        }
      }
    } catch (e: any) {
      console.error('[StateManager] Failed to load state:', e);
      // FAIL-CLOSED: Reset sensitive in-memory state if loading/migration fails
      this.state = {
        ...INITIAL_STATE,
        persistenceError: `Fail-closed: State load or migration failed (${e?.message || e}). In-memory state purged.`,
      };
      throw e;
    }
  }

  /** Reload state from disk once OS secure storage subsystem is available. */
  public reloadFromDisk(): void {
    try {
      this.load();
    } finally {
      this.notify();
    }
  }

  private save(throwOnError: boolean = false) {
    try {
      const stateFile = this.getStateFilePath();
      const dir = path.dirname(stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);

      // Clean serialization copy: ensure no secrets or screenshot payloads are saved to disk
      const toSave: any = { ...this.state };
      delete toSave.apiKeys;
      // The package version is runtime metadata, not a user preference.
      delete toSave.appVersion;
      // Persistence diagnostics are transient UI state and must never be stored in the file.
      delete toSave.persistenceError;
      // Capture readiness and error notices describe the previous process/device lifecycle.
      // Never restore them after restart; the renderer will negotiate fresh streams.
      delete toSave.microphoneCaptureStatus;
      delete toSave.systemAudioCaptureStatus;
      delete toSave.captureWarning;

      // Enterprise Mode disk suppression: active transcripts, messages, and knowledge docs must NEVER touch disk
      if (this.state.enterpriseMode) {
        toSave.session = null;
        toSave.knowledgeDocs = [];
      } else if (toSave.session && Array.isArray(toSave.session.messages)) {
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

      const serialized = JSON.stringify(toSave, null, 2);
      // Permanent authenticated encryption at rest: plaintext JSON files are never written directly to disk
      const payloadToWrite = encryptStoragePayload(serialized);

      fs.writeFileSync(stateFile, payloadToWrite, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(stateFile, 0o600);
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
