import { ipcMain, IpcMainInvokeEvent, IpcMainEvent, session, desktopCapturer, app } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { stateManager } from './state';
import { screenshotService } from './screenshot';
import { windowCoordinator } from './windows';
import { credentialVault } from '../services/vault';
import { sessionRepository, SessionRecord } from '../services/session-repository';
import { SharedState } from '../../src/lib/types';
import { streamGemini, streamOpenAI, streamClaude, streamOllama, transcribeAudio } from '../../src/lib/providers';

const BOOLEAN_STATE_KEYS = new Set([
  'showChat',
  'showDashboard',
  'chatWindowIsExpanded',
  'isStealthMode',
  'isRecording',
  'meHasVoiceActivity',
  'themHasVoiceActivity',
  'isCapturingScreenshot',
]);

const ALLOWED_OPERATING_MODES = new Set([
  'copilot',
  'interview',
  'coding',
  'sales',
  'executive',
]);

const ALLOWED_SHORTCUT_KEYS = new Set([
  'toggleVisibility',
  'ask',
  'clear',
  'toggleSession',
  'moveUp',
  'moveDown',
  'moveLeft',
  'moveRight',
]);

const MAX_TRANSCRIPT_ITEMS = 5000;
const MAX_MESSAGES_ITEMS = 1000;
const MAX_KNOWLEDGE_DOCS = 500;
const MAX_CONTENT_LENGTH = 2000000; // 2MB max for doc content
const VALID_TRANSCRIPT_ROLES = new Set(['me', 'them']);
const VALID_TRANSCRIPT_STATUSES = new Set(['transcribing', 'ready', 'error']);
const VALID_MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);
const VALID_DOC_SOURCE_TYPES = new Set(['pasted', 'file']);

const ALLOWED_STATE_KEYS = new Set([
  ...BOOLEAN_STATE_KEYS,
  'activeMode',
  'activeModel',
  'shortcuts',
  'session',
  'knowledgeDocs',
]);

export class IpcRouter {
  private customTrustedHtmlPath?: string;

  constructor(customTrustedHtmlPath?: string) {
    if (customTrustedHtmlPath) {
      this.customTrustedHtmlPath = path.normalize(customTrustedHtmlPath).toLowerCase();
    }
  }

  public init() {
    this.setupDisplayMediaHandler();
    this.registerHandlers();
  }

  /**
   * Sets up system audio loopback capture handler on Windows.
   * When renderer requests getDisplayMedia({ video: true, audio: true }),
   * this automatically grants the primary display with loopback audio.
   */
  private setupDisplayMediaHandler() {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then(sources => {
          const primarySource = sources[0];
          if (!primarySource) {
            callback({});
            return;
          }
          callback({
            video: primarySource,
            audio: 'loopback',
          });
        })
        .catch(err => {
          console.error('[IpcRouter] Error selecting display media loopback source:', err);
          callback({});
        });
    });
  }

  /**
   * Resolves the canonical, normalized file path to the production index.html.
   */
  public getTrustedAppHtmlPath(): string {
    if (this.customTrustedHtmlPath) {
      return this.customTrustedHtmlPath;
    }
    try {
      if (app && typeof app.getAppPath === 'function') {
        return path.normalize(path.join(app.getAppPath(), 'dist', 'index.html')).toLowerCase();
      }
    } catch {
      // fallback
    }
    return path.normalize(path.join(process.cwd(), 'dist', 'index.html')).toLowerCase();
  }

  /**
   * Strict sender frame origin verification.
   * Fails closed: Rejects missing senderFrame, unparseable URLs, or origins outside the trusted app bundle.
   */
  public validateOrigin(event: IpcMainInvokeEvent | IpcMainEvent): void {
    const frame = event.senderFrame;
    if (!frame || !frame.url) {
      throw new Error('[IpcRouter] Rejected IPC request: Missing sender frame context');
    }

    const rawUrl = frame.url;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new Error(`[IpcRouter] Rejected malformed URL: ${rawUrl}`);
    }

    // 1. Development Mode Validation:
    // If VITE_DEV_SERVER_URL is configured, match its exact origin (protocol, hostname, port)
    if (process.env.VITE_DEV_SERVER_URL) {
      try {
        const devServer = new URL(process.env.VITE_DEV_SERVER_URL);
        if (
          parsedUrl.protocol === devServer.protocol &&
          parsedUrl.hostname === devServer.hostname &&
          parsedUrl.port === devServer.port
        ) {
          return;
        }
      } catch {
        // Fall through if VITE_DEV_SERVER_URL is unparseable
      }
    }

    // Standard local Vite dev server check:
    // Protocol must be strictly http:, hostname strictly 'localhost' or '127.0.0.1', and port strictly '5173'
    if (
      parsedUrl.protocol === 'http:' &&
      (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1') &&
      parsedUrl.port === '5173'
    ) {
      return;
    }

    // 2. Production Mode Validation:
    // Protocol MUST be file:
    if (parsedUrl.protocol === 'file:') {
      try {
        const normalizedFilePath = path.normalize(fileURLToPath(parsedUrl)).toLowerCase();
        const expectedHtmlPath = this.getTrustedAppHtmlPath();

        if (normalizedFilePath === expectedHtmlPath) {
          return;
        }
      } catch {
        // Any unparseable or non-absolute file URL falls through to unauthorized rejection
      }
    }

    // Zero substring fallbacks! Reject any lookalikes or untrusted domains.
    throw new Error(`[IpcRouter] Rejected unauthorized origin: ${rawUrl}`);
  }

  /**
   * Validates patch object strictly against permitted whitelist and per-field type schemas.
   * Rejects malformed values, prototype pollutants, or invalid enum variants.
   */
  public sanitizePatchState(patch: any): Partial<SharedState> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('[IpcRouter] Invalid patch: Payload must be a non-null object');
    }

    const sanitized: any = {};
    for (const [key, val] of Object.entries(patch)) {
      if (!ALLOWED_STATE_KEYS.has(key)) {
        throw new Error(`[IpcRouter] Unauthorized state field in patch: "${key}"`);
      }

      // 1. Validate boolean flags
      if (BOOLEAN_STATE_KEYS.has(key)) {
        if (typeof val !== 'boolean') {
          throw new Error(`[IpcRouter] Invalid type for boolean field "${key}": expected boolean, got ${typeof val}`);
        }
        sanitized[key] = val;
      }

      // 2. Validate operating mode enum
      else if (key === 'activeMode') {
        if (typeof val !== 'string' || !ALLOWED_OPERATING_MODES.has(val)) {
          throw new Error(
            `[IpcRouter] Invalid activeMode: "${val}". Must be one of: ${Array.from(ALLOWED_OPERATING_MODES).join(', ')}`
          );
        }
        sanitized[key] = val;
      }

      // 3. Validate active model name
      else if (key === 'activeModel') {
        if (typeof val !== 'string' || val.trim().length === 0 || val.length > 100) {
          throw new Error('[IpcRouter] Invalid activeModel: Expected non-empty string under 100 characters');
        }
        sanitized[key] = val.trim();
      }

      // 4. Validate shortcuts mapping
      else if (key === 'shortcuts') {
        if (!val || typeof val !== 'object' || Array.isArray(val)) {
          throw new Error('[IpcRouter] Invalid shortcuts payload: Expected object map of accelerator strings');
        }
        const cleanShortcuts: Record<string, string> = {};
        for (const [sKey, sVal] of Object.entries(val)) {
          if (!ALLOWED_SHORTCUT_KEYS.has(sKey)) {
            throw new Error(`[IpcRouter] Unknown shortcut action: "${sKey}"`);
          }
          if (typeof sVal !== 'string' || sVal.trim().length === 0) {
            throw new Error(`[IpcRouter] Invalid accelerator for shortcut "${sKey}": Expected non-empty string`);
          }
          cleanShortcuts[sKey] = sVal.trim();
        }
        sanitized[key] = cleanShortcuts;
      }

      // 5. Validate session record structure and nested fields
      else if (key === 'session') {
        if (val === null) {
          sanitized[key] = null;
        } else {
          if (typeof val !== 'object' || Array.isArray(val)) {
            throw new Error('[IpcRouter] Invalid session: Expected null or SessionState object');
          }
          const sessObj = val as any;
          if (typeof sessObj.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(sessObj.id)) {
            throw new Error('[IpcRouter] Invalid session: Session ID must match /^[a-zA-Z0-9_-]{1,64}$/');
          }
          if (typeof sessObj.createdAt !== 'string' || isNaN(Date.parse(sessObj.createdAt))) {
            throw new Error('[IpcRouter] Invalid session: Missing or invalid createdAt ISO timestamp');
          }
          if (sessObj.updatedAt !== undefined && (typeof sessObj.updatedAt !== 'string' || isNaN(Date.parse(sessObj.updatedAt)))) {
            throw new Error('[IpcRouter] Invalid session: Invalid updatedAt ISO timestamp');
          }
          if (sessObj.title !== undefined && (typeof sessObj.title !== 'string' || sessObj.title.length > 255)) {
            throw new Error('[IpcRouter] Invalid session: title must be string under 255 chars');
          }
          if (sessObj.durationSeconds !== undefined && (typeof sessObj.durationSeconds !== 'number' || !Number.isFinite(sessObj.durationSeconds) || sessObj.durationSeconds < 0)) {
            throw new Error('[IpcRouter] Invalid session: durationSeconds must be non-negative finite number');
          }
          if (sessObj.mode !== undefined && (!ALLOWED_OPERATING_MODES.has(sessObj.mode))) {
            throw new Error(`[IpcRouter] Invalid session: mode "${sessObj.mode}" is not a recognized operating mode`);
          }

          // Nested transcript validation
          if (!Array.isArray(sessObj.transcript)) {
            throw new Error('[IpcRouter] Invalid session: transcript must be an array');
          }
          if (sessObj.transcript.length > MAX_TRANSCRIPT_ITEMS) {
            throw new Error(`[IpcRouter] Invalid session: transcript exceeds maximum limit of ${MAX_TRANSCRIPT_ITEMS} items`);
          }
          for (let i = 0; i < sessObj.transcript.length; i++) {
            const item = sessObj.transcript[i];
            if (!item || typeof item !== 'object') throw new Error(`[IpcRouter] Invalid transcript item at index ${i}: Expected object`);
            if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)) {
              throw new Error(`[IpcRouter] Invalid transcript item at index ${i}: ID must match /^[a-zA-Z0-9_-]{1,64}$/`);
            }
            if (typeof item.createdAt !== 'string' || isNaN(Date.parse(item.createdAt))) {
              throw new Error(`[IpcRouter] Invalid transcript item at index ${i}: Invalid createdAt timestamp`);
            }
            if (typeof item.relativeMs !== 'number' || !Number.isFinite(item.relativeMs) || item.relativeMs < 0) {
              throw new Error(`[IpcRouter] Invalid transcript item at index ${i}: relativeMs must be non-negative finite number`);
            }
            if (!VALID_TRANSCRIPT_ROLES.has(item.role)) {
              throw new Error(`[IpcRouter] Invalid transcript item at index ${i}: role must be "me" or "them"`);
            }
            if (!VALID_TRANSCRIPT_STATUSES.has(item.status)) {
              throw new Error(`[IpcRouter] Invalid transcript item at index ${i}: status must be transcribing, ready, or error`);
            }
            if (typeof item.text !== 'string' || item.text.length > 10000) {
              throw new Error(`[IpcRouter] Invalid transcript item at index ${i}: text must be string under 10000 chars`);
            }
          }

          // Nested messages validation
          if (!Array.isArray(sessObj.messages)) {
            throw new Error('[IpcRouter] Invalid session: messages must be an array');
          }
          if (sessObj.messages.length > MAX_MESSAGES_ITEMS) {
            throw new Error(`[IpcRouter] Invalid session: messages exceeds maximum limit of ${MAX_MESSAGES_ITEMS} items`);
          }
          for (let i = 0; i < sessObj.messages.length; i++) {
            const msg = sessObj.messages[i];
            if (!msg || typeof msg !== 'object') throw new Error(`[IpcRouter] Invalid message at index ${i}: Expected object`);
            if (typeof msg.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(msg.id)) {
              throw new Error(`[IpcRouter] Invalid message at index ${i}: ID must match /^[a-zA-Z0-9_-]{1,64}$/`);
            }
            if (!VALID_MESSAGE_ROLES.has(msg.role)) {
              throw new Error(`[IpcRouter] Invalid message at index ${i}: role must be user, assistant, or system`);
            }
            if (typeof msg.content !== 'string' || msg.content.length > 500000) {
              throw new Error(`[IpcRouter] Invalid message at index ${i}: content exceeds 500,000 char limit`);
            }
            if (typeof msg.createdAt !== 'string' || isNaN(Date.parse(msg.createdAt))) {
              throw new Error(`[IpcRouter] Invalid message at index ${i}: Invalid createdAt timestamp`);
            }
            if (msg.screenshot !== undefined && (typeof msg.screenshot !== 'string' || msg.screenshot.length > 15000000)) {
              throw new Error(`[IpcRouter] Invalid message at index ${i}: screenshot exceeds 15MB size limit`);
            }
            if (msg.sources !== undefined) {
              if (!Array.isArray(msg.sources) || msg.sources.length > 50) {
                throw new Error(`[IpcRouter] Invalid message at index ${i}: sources must be an array under 50 items`);
              }
              for (const src of msg.sources) {
                if (typeof src !== 'string' || src.length > 500) {
                  throw new Error(`[IpcRouter] Invalid source entry at message ${i}: Expected string under 500 chars`);
                }
              }
            }
          }

          sanitized[key] = val;
        }
      }

      // 6. Validate knowledgeDocs array and nested schema
      else if (key === 'knowledgeDocs') {
        if (!Array.isArray(val)) {
          throw new Error('[IpcRouter] Invalid knowledgeDocs: Expected an array of documents');
        }
        if (val.length > MAX_KNOWLEDGE_DOCS) {
          throw new Error(`[IpcRouter] Invalid knowledgeDocs: Exceeds maximum limit of ${MAX_KNOWLEDGE_DOCS} documents`);
        }
        for (let i = 0; i < val.length; i++) {
          const docObj = val[i] as any;
          if (!docObj || typeof docObj !== 'object') {
            throw new Error(`[IpcRouter] Invalid document at index ${i}: Expected object`);
          }
          if (typeof docObj.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(docObj.id)) {
            throw new Error(`[IpcRouter] Invalid document at index ${i}: ID must match /^[a-zA-Z0-9_-]{1,64}$/`);
          }
          if (typeof docObj.title !== 'string' || docObj.title.trim().length === 0 || docObj.title.length > 255) {
            throw new Error(`[IpcRouter] Invalid document at index ${i}: title must be between 1 and 255 chars`);
          }
          if (typeof docObj.content !== 'string') {
            throw new Error(`[IpcRouter] Invalid document at index ${i}: Missing id, title, or content`);
          }
          if (docObj.content.length > MAX_CONTENT_LENGTH) {
            throw new Error(`[IpcRouter] Invalid document at index ${i}: content exceeds ${MAX_CONTENT_LENGTH} char limit`);
          }
          if (docObj.sourceType !== undefined && !VALID_DOC_SOURCE_TYPES.has(docObj.sourceType)) {
            throw new Error(`[IpcRouter] Invalid document at index ${i}: sourceType must be "pasted" or "file"`);
          }
          if (docObj.fileName !== undefined && (typeof docObj.fileName !== 'string' || docObj.fileName.length > 255)) {
            throw new Error(`[IpcRouter] Invalid document at index ${i}: fileName must be string under 255 chars`);
          }
          if (docObj.chunks !== undefined) {
            if (!Array.isArray(docObj.chunks) || docObj.chunks.length > 2000) {
              throw new Error(`[IpcRouter] Invalid document at index ${i}: chunks must be array under 2000 items`);
            }
          }
        }
        sanitized[key] = val;
      }
    }

    return sanitized;
  }

  private registerHandlers() {
    // 1. Get Shared State
    ipcMain.handle('get-shared-state', (event): SharedState => {
      this.validateOrigin(event);
      return stateManager.getState();
    });

    // 2. Patch Shared State (with strict schema sanitization)
    ipcMain.handle('patch-shared-state', (event, rawPatch: any) => {
      this.validateOrigin(event);
      const cleanPatch = this.sanitizePatchState(rawPatch);
      return stateManager.patchState(cleanPatch);
    });

    // 3. Screen Capture (returns display matching active window downscaled to max 1920)
    ipcMain.handle('capture-screenshot', async event => {
      this.validateOrigin(event);
      stateManager.patchState({ isCapturingScreenshot: true });
      try {
        const controlWin = windowCoordinator.getControlWindow();
        return await screenshotService.captureScreen(controlWin);
      } finally {
        stateManager.patchState({ isCapturingScreenshot: false });
      }
    });

    // 4. Content Protection (Stealth Mode)
    ipcMain.handle('toggle-stealth-mode', (event, enable: boolean) => {
      this.validateOrigin(event);
      if (typeof enable !== 'boolean') throw new Error('Expected boolean parameter');
      stateManager.patchState({ isStealthMode: enable });
      windowCoordinator.updateStealthMode(enable);
      return enable;
    });

    // 5. Window Dragging
    ipcMain.on('drag-control-window', (event, delta: any) => {
      this.validateOrigin(event);
      if (typeof delta?.x === 'number' && typeof delta?.y === 'number') {
        windowCoordinator.moveControlWindow(delta);
      }
    });

    // 6. Window Resize
    ipcMain.on('resize-chat-window', (event, height: any) => {
      this.validateOrigin(event);
      if (typeof height !== 'number') return;
      const chatWin = windowCoordinator.getChatWindow();
      if (chatWin && !chatWin.isDestroyed()) {
        const bounds = chatWin.getBounds();
        chatWin.setBounds({ ...bounds, height: Math.max(260, Math.min(height, 800)) });
      }
    });

    // 7. Open Dashboard
    ipcMain.on('open-dashboard', (event, tab?: any) => {
      this.validateOrigin(event);
      const safeTab = typeof tab === 'string' ? tab : undefined;
      windowCoordinator.openDashboardWindow(safeTab);
    });

    // 8. Secure Credential Vault Handlers
    ipcMain.handle('vault-save-key', async (event, { provider, key }: any) => {
      this.validateOrigin(event);
      if (!provider || typeof provider !== 'string') throw new Error('Invalid provider');
      if (!key || typeof key !== 'string') throw new Error('Invalid API key');
      await credentialVault.setKey(provider, key);
      await stateManager.syncVaultKeys();
    });

    ipcMain.handle('vault-delete-key', async (event, { provider }: any) => {
      this.validateOrigin(event);
      if (!provider || typeof provider !== 'string') throw new Error('Invalid provider');
      await credentialVault.deleteKey(provider);
      await stateManager.syncVaultKeys();
    });

    ipcMain.handle('vault-has-keys', async event => {
      this.validateOrigin(event);
      return await credentialVault.hasKeys();
    });

    // 9. AI Execution Bridge (Executes with keys fetched directly from vault)
    ipcMain.handle('ai-stream-request', async (event, options: any) => {
      this.validateOrigin(event);
      const { model, mode, query, screenshotBase64, recentTranscript, knowledgePassages } = options;
      const senderWebContents = event.sender;

      // Determine required provider
      let providerName = 'gemini';
      if (model.includes('gpt') || model.includes('openai')) providerName = 'openai';
      else if (model.includes('claude') || model.includes('anthropic')) providerName = 'anthropic';
      else if (model.includes('ollama')) providerName = 'ollama';

      const apiKey = await credentialVault.getKey(providerName);
      if (!apiKey && providerName !== 'ollama') {
        throw new Error(`No API key configured for ${providerName}. Please add it in Settings.`);
      }

      const onToken = (token: string) => {
        if (!senderWebContents.isDestroyed()) {
          senderWebContents.send('ai-token-stream', token);
        }
      };

      let resultText = '';
      if (providerName === 'gemini') {
        resultText = await streamGemini({
          model,
          apiKey: apiKey || '',
          mode,
          query,
          screenshotBase64,
          recentTranscript,
          knowledgePassages,
          onToken,
        });
      } else if (providerName === 'openai') {
        resultText = await streamOpenAI({
          model,
          apiKey: apiKey || '',
          mode,
          query,
          screenshotBase64,
          recentTranscript,
          knowledgePassages,
          onToken,
        });
      } else if (providerName === 'anthropic') {
        resultText = await streamClaude({
          model,
          apiKey: apiKey || '',
          mode,
          query,
          screenshotBase64,
          recentTranscript,
          knowledgePassages,
          onToken,
        });
      } else if (providerName === 'ollama') {
        resultText = await streamOllama({
          model,
          mode,
          query,
          screenshotBase64,
          recentTranscript,
          knowledgePassages,
          onToken,
        });
      }

      return { content: resultText, sources: knowledgePassages };
    });

    // 10. STT Transcription Bridge
    ipcMain.handle('stt-transcribe-payload', async (event, { wavBase64, language }: any) => {
      this.validateOrigin(event);
      if (!wavBase64 || typeof wavBase64 !== 'string') {
        throw new Error('Missing wavBase64 audio payload');
      }

      const groqKey = await credentialVault.getKey('groq');
      const openaiKey = await credentialVault.getKey('openai');
      const activeKey = groqKey || openaiKey;
      const provider = groqKey ? 'groq' : 'openai';

      if (!activeKey) {
        throw new Error('No Speech-to-Text key configured. Set Groq or OpenAI key in Settings.');
      }

      const buf = Buffer.from(wavBase64, 'base64');
      const text = await transcribeAudio(buf.buffer, activeKey, provider, language || 'en');
      return { text };
    });

    // 11. Multi-Session Repository Handlers
    ipcMain.handle('session-save', async (event, session: SessionRecord) => {
      this.validateOrigin(event);
      await sessionRepository.saveSession(session);
    });

    ipcMain.handle('session-list', async event => {
      this.validateOrigin(event);
      return await sessionRepository.listSessions();
    });

    ipcMain.handle('session-get', async (event, id: string) => {
      this.validateOrigin(event);
      return await sessionRepository.getSession(id);
    });

    ipcMain.handle('session-delete', async (event, id: string) => {
      this.validateOrigin(event);
      return await sessionRepository.deleteSession(id);
    });

    ipcMain.handle('session-purge-all', async event => {
      this.validateOrigin(event);
      await sessionRepository.purgeAll();
    });

    // Broadcast state updates to windows
    stateManager.subscribe(state => {
      const wins = [windowCoordinator.getControlWindow(), windowCoordinator.getChatWindow()];
      for (const win of wins) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('shared-state-updated', state);
        }
      }
    });
  }
}

export const ipcRouter = new IpcRouter();
