import { ipcMain, IpcMainInvokeEvent, IpcMainEvent, session, desktopCapturer, app } from 'electron';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { stateManager } from './state';
import { screenshotService } from './screenshot';
import { windowCoordinator } from './windows';
import { credentialVault } from '../services/vault';
import { sessionRepository, SessionRecord } from '../services/session-repository';
import { SharedState } from '../../src/lib/types';
import { broadcastSharedStateToAppWindows } from './state-broadcast';
import { streamGemini, streamOpenAI, streamClaude, streamOllama, transcribeAudio } from '../../src/lib/providers';

const BOOLEAN_STATE_KEYS = new Set([
  'showChat',
  'showDashboard',
  'chatWindowIsExpanded',
  'isStealthMode',
  'isRecording',
  'microphoneCaptureStatus',
  'systemAudioCaptureStatus',
  'captureWarning',
  'isEmergencyStopping',
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
  'emergencyStop',
  'toggleSession',
  'moveUp',
  'moveDown',
  'moveLeft',
  'moveRight',
]);

const MAX_TRANSCRIPT_ITEMS = 5000;
const MAX_MESSAGES_ITEMS = 1000;
const MAX_KNOWLEDGE_DOCS = 500;
const MAX_CONTENT_LENGTH = 2000000; // 2 MiB maximum per document
const MAX_KNOWLEDGE_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_KNOWLEDGE_TOTAL_CHUNKS = 10000;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_STT_AUDIO_BASE64_CHARS = 8 * 1024 * 1024;
const MAX_STT_AUDIO_BYTES = 6 * 1024 * 1024;
const MAX_STT_AUDIO_DURATION_MS = 20000; // Matches VADProcessor.maxSegmentMs
const MAX_AI_QUERY_CHARS = 20000;
const MAX_AI_SCREENSHOT_BASE64_CHARS = 8 * 1024 * 1024;
const MAX_AI_HISTORY_ITEMS = 50;
const MAX_AI_HISTORY_TOTAL_CHARS = 100000;
const MAX_AI_TRANSCRIPT_ITEMS = 100;
const MAX_AI_TRANSCRIPT_TOTAL_CHARS = 50000;
const MAX_AI_KNOWLEDGE_PASSAGES = 10;
const MAX_AI_KNOWLEDGE_TOTAL_CHARS = 80000;
const VALID_TRANSCRIPT_ROLES = new Set(['me', 'them']);
const VALID_TRANSCRIPT_STATUSES = new Set(['transcribing', 'ready', 'error']);
const VALID_MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);
const VALID_DOC_SOURCE_TYPES = new Set(['pasted', 'file']);
const VALID_CAPTURE_STATUSES = new Set(['idle', 'starting', 'active', 'unavailable', 'error']);

const ALLOWED_STATE_KEYS = new Set([
  ...BOOLEAN_STATE_KEYS,
  'activeMode',
  'activeModel',
  'shortcuts',
  'session',
  'knowledgeDocs',
]);

export interface ActiveRequest {
  operationId: string;
  correlationId?: string;
  controller: AbortController;
}

/**
 * Renderer request IDs are cancellation correlation keys only. The provider
 * operation ID is generated within the trusted main process.
 */
export class ActiveRequestRegistry {
  private controllers = new Map<string, AbortController>();
  private operationByCorrelationId = new Map<string, string>();

  public start(rawCorrelationId?: unknown): ActiveRequest {
    let correlationId: string | undefined;
    if (rawCorrelationId !== undefined && rawCorrelationId !== null) {
      if (typeof rawCorrelationId !== 'string' || rawCorrelationId.trim().length === 0 || rawCorrelationId.length > 128) {
        throw new Error('Invalid AI request correlation ID');
      }
      correlationId = rawCorrelationId.trim();
      if (this.operationByCorrelationId.has(correlationId)) {
        throw new Error('An AI request with this correlation ID is already active');
      }
    }

    const operationId = randomUUID();
    const controller = new AbortController();
    this.controllers.set(operationId, controller);
    if (correlationId) this.operationByCorrelationId.set(correlationId, operationId);
    return { operationId, correlationId, controller };
  }

  public complete(operationId: string, correlationId?: string): void {
    this.controllers.delete(operationId);
    if (correlationId && this.operationByCorrelationId.get(correlationId) === operationId) {
      this.operationByCorrelationId.delete(correlationId);
    }
  }

  public abort(correlationId: string): boolean {
    const operationId = this.operationByCorrelationId.get(correlationId);
    if (!operationId) return false;
    const controller = this.controllers.get(operationId);
    if (!controller) {
      this.operationByCorrelationId.delete(correlationId);
      return false;
    }
    controller.abort();
    this.complete(operationId, correlationId);
    return true;
  }

  public abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.operationByCorrelationId.clear();
  }

  public get size(): number {
    return this.controllers.size;
  }
}

export class IpcRouter {
  private customTrustedHtmlPath?: string;
  private forceProductionMode: boolean = false;
  private activeAiControllers = new ActiveRequestRegistry();
  private activeAiTasks: Set<Promise<void>> = new Set();
  private activeTranscriptionControllers: Set<AbortController> = new Set();
  private activeTranscriptionTasks: Set<Promise<string>> = new Set();

  constructor(customTrustedHtmlPath?: string, forceProductionMode: boolean = false) {
    if (customTrustedHtmlPath) {
      this.customTrustedHtmlPath = path.normalize(customTrustedHtmlPath).toLowerCase();
    }
    this.forceProductionMode = forceProductionMode;
  }

  /** Immediately stops capture and aborts active AI/STT work without deleting session history. */
  public emergencyStop(): void {
    const currentState = stateManager.getState();
    this.activeAiControllers.abortAll();
    for (const controller of this.activeTranscriptionControllers) controller.abort();
    stateManager.patchState({
      isRecording: false,
      isEmergencyStopping: !currentState.isPurging,
      isGenerating: false,
      meHasVoiceActivity: false,
      themHasVoiceActivity: false,
    });
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
      // 1. Verify that the requesting frame originates from a trusted local origin
      try {
        this.validateOrigin({ senderFrame: request.frame } as any);
      } catch (e) {
        console.warn('[IpcRouter] Denied display media request: Unauthorized frame origin');
        callback({});
        return;
      }

      // 2. Verify that recording is explicitly active in shared state
      const state = stateManager.getState();
      if (!state.isRecording) {
        console.warn('[IpcRouter] Denied display media request: Recording is not active');
        callback({});
        return;
      }

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

    // Check production mode status (explicit override or packaged Electron app)
    const isProd = this.forceProductionMode || (app && app.isPackaged);

    // 1. Development Mode Validation (strictly disallowed in production mode):
    // If VITE_DEV_SERVER_URL is configured, match its exact origin (protocol, hostname, port)
    if (!isProd && process.env.VITE_DEV_SERVER_URL) {
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

    // Standard local Vite dev server check (strictly prohibited in production mode):
    // Protocol must be strictly http:, hostname strictly 'localhost' or '127.0.0.1', and port strictly '5173'
    if (
      !isProd &&
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
   * Reject oversized or malformed generation context before provider work begins.
   * Limits are aggregate as well as per collection so many small items cannot bypass them.
   */
  public validateAiRequestOptions(options: any): void {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('[IpcRouter] Invalid AI request: expected an options object');
    }
    if (typeof options.model !== 'string' || options.model.trim().length === 0 || options.model.length > 100) {
      throw new Error('[IpcRouter] Invalid AI request model');
    }
    if (typeof options.mode !== 'string' || !ALLOWED_OPERATING_MODES.has(options.mode)) {
      throw new Error('[IpcRouter] Invalid AI request mode');
    }
    if (typeof options.query !== 'string' || options.query.length > MAX_AI_QUERY_CHARS) {
      throw new Error(`[IpcRouter] AI query exceeds the ${MAX_AI_QUERY_CHARS} character limit`);
    }

    const screenshot = options.screenshotBase64;
    if (screenshot !== undefined && screenshot !== null &&
      (typeof screenshot !== 'string' || screenshot.length > MAX_AI_SCREENSHOT_BASE64_CHARS)) {
      throw new Error('[IpcRouter] Screenshot context exceeds the 8 MiB encoded size limit');
    }

    const transcript = options.recentTranscript ?? [];
    if (!Array.isArray(transcript) || transcript.length > MAX_AI_TRANSCRIPT_ITEMS) {
      throw new Error(`[IpcRouter] AI transcript context exceeds ${MAX_AI_TRANSCRIPT_ITEMS} items`);
    }
    let transcriptChars = 0;
    for (const [index, item] of transcript.entries()) {
      if (!item || typeof item !== 'object' || typeof item.text !== 'string' || item.text.length > 10000) {
        throw new Error(`[IpcRouter] Invalid AI transcript context item at index ${index}`);
      }
      transcriptChars += item.text.length;
    }
    if (transcriptChars > MAX_AI_TRANSCRIPT_TOTAL_CHARS) {
      throw new Error('[IpcRouter] AI transcript context exceeds the 50000 character aggregate limit');
    }

    const history = options.conversationHistory ?? [];
    if (!Array.isArray(history) || history.length > MAX_AI_HISTORY_ITEMS) {
      throw new Error(`[IpcRouter] AI conversation history exceeds ${MAX_AI_HISTORY_ITEMS} items`);
    }
    let historyChars = 0;
    for (const [index, item] of history.entries()) {
      if (!item || typeof item !== 'object' ||
        !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') {
        throw new Error(`[IpcRouter] Invalid AI conversation history item at index ${index}`);
      }
      historyChars += item.content.length;
    }
    if (historyChars > MAX_AI_HISTORY_TOTAL_CHARS) {
      throw new Error('[IpcRouter] AI conversation history exceeds the 100000 character aggregate limit');
    }

    const passages = options.knowledgePassages ?? [];
    if (!Array.isArray(passages) || passages.length > MAX_AI_KNOWLEDGE_PASSAGES ||
      passages.some(passage => typeof passage !== 'string')) {
      throw new Error(`[IpcRouter] AI knowledge context exceeds ${MAX_AI_KNOWLEDGE_PASSAGES} passages or contains invalid data`);
    }
    const passageChars = passages.reduce((total: number, passage: string) => total + passage.length, 0);
    if (passageChars > MAX_AI_KNOWLEDGE_TOTAL_CHARS) {
      throw new Error('[IpcRouter] AI knowledge context exceeds the 80000 character aggregate limit');
    }
  }

  /**
   * Validates the renderer's canonical mono 16 kHz, 16-bit PCM WAV payload.
   * The duration cap matches VADProcessor.maxSegmentMs.
   */
  public validateSttAudioPayload(wavBase64: unknown): Buffer {
    if (typeof wavBase64 !== 'string' || wavBase64.length === 0) {
      throw new Error('Missing wavBase64 audio payload');
    }
    if (wavBase64.length > MAX_STT_AUDIO_BASE64_CHARS) {
      throw new Error('Audio payload exceeds the 8 MiB encoded size limit');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(wavBase64) || wavBase64.length % 4 !== 0) {
      throw new Error('Audio payload is not valid base64');
    }

    const buffer = Buffer.from(wavBase64, 'base64');
    if (buffer.toString('base64') !== wavBase64) {
      throw new Error('Audio payload is not canonical base64');
    }
    if (buffer.byteLength > MAX_STT_AUDIO_BYTES) {
      throw new Error('Decoded audio payload exceeds the 6 MiB size limit');
    }

    const isCanonicalPcmWav = buffer.byteLength >= 44 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WAVE' &&
      buffer.toString('ascii', 12, 16) === 'fmt ' &&
      buffer.toString('ascii', 36, 40) === 'data' &&
      buffer.readUInt32LE(4) === buffer.byteLength - 8 &&
      buffer.readUInt32LE(16) === 16 &&
      buffer.readUInt16LE(20) === 1 &&
      buffer.readUInt16LE(22) === 1 &&
      buffer.readUInt32LE(24) === 16000 &&
      buffer.readUInt32LE(28) === 32000 &&
      buffer.readUInt16LE(32) === 2 &&
      buffer.readUInt16LE(34) === 16;
    if (!isCanonicalPcmWav) {
      throw new Error('Audio payload must be a canonical mono 16 kHz, 16-bit PCM WAV');
    }

    const dataBytes = buffer.readUInt32LE(40);
    if (dataBytes === 0 || dataBytes !== buffer.byteLength - 44 || dataBytes % 2 !== 0) {
      throw new Error('Audio WAV data chunk is malformed');
    }
    const durationMs = (dataBytes / 32000) * 1000;
    if (durationMs > MAX_STT_AUDIO_DURATION_MS) {
      throw new Error('Audio payload exceeds the 20-second duration limit');
    }

    return buffer;
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

      // Capture status is a small finite state machine, never arbitrary renderer text.
      else if (key === 'microphoneCaptureStatus' || key === 'systemAudioCaptureStatus') {
        if (typeof val !== 'string' || !VALID_CAPTURE_STATUSES.has(val)) {
          throw new Error(`[IpcRouter] Invalid capture status for "${key}"`);
        }
        sanitized[key] = val;
      }

      // Capture warning is user-visible diagnostics, bounded to avoid oversized state patches.
      else if (key === 'captureWarning') {
        if (val !== null && (typeof val !== 'string' || val.length > 256)) {
          throw new Error('[IpcRouter] Invalid capture warning: expected null or a string up to 256 characters');
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
          sanitized[key] = this.sanitizeSessionRecord(val);
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
        let totalKnowledgeBytes = 0;
        let totalKnowledgeChunks = 0;
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
          const contentBytes = Buffer.byteLength(docObj.content, 'utf8');
          if (contentBytes > MAX_CONTENT_LENGTH) {
            throw new Error(`[IpcRouter] Invalid document at index ${i}: content exceeds ${MAX_CONTENT_LENGTH} byte limit`);
          }
          totalKnowledgeBytes += contentBytes;
          if (totalKnowledgeBytes > MAX_KNOWLEDGE_TOTAL_BYTES) {
            throw new Error(`[IpcRouter] Invalid knowledgeDocs: aggregate document content exceeds ${MAX_KNOWLEDGE_TOTAL_BYTES} bytes`);
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
            totalKnowledgeChunks += docObj.chunks.length;
            if (totalKnowledgeChunks > MAX_KNOWLEDGE_TOTAL_CHUNKS) {
              throw new Error(`[IpcRouter] Invalid knowledgeDocs: aggregate chunk count exceeds ${MAX_KNOWLEDGE_TOTAL_CHUNKS}`);
            }
            for (const [chunkIndex, chunk] of docObj.chunks.entries()) {
              if (typeof chunk !== 'string' || Buffer.byteLength(chunk, 'utf8') > MAX_CHUNK_BYTES) {
                throw new Error(`[IpcRouter] Invalid document at index ${i}: chunk ${chunkIndex} exceeds the 256 KiB limit or is not text`);
              }
              totalKnowledgeBytes += Buffer.byteLength(chunk, 'utf8');
              if (totalKnowledgeBytes > MAX_KNOWLEDGE_TOTAL_BYTES) {
                throw new Error(`[IpcRouter] Invalid knowledgeDocs: aggregate content and chunk bytes exceed ${MAX_KNOWLEDGE_TOTAL_BYTES}`);
              }
            }
          }
        }
        sanitized[key] = val;
      }
    }

    return sanitized;
  }

  /**
   * Deep schema sanitization for session records across both state-patch and session-save.
   * Strips raw screenshot payloads to prevent storage bloat and memory leaks.
   * Enforces a strict 5MB aggregate payload limit.
   */
  public sanitizeSessionRecord(val: any): SessionRecord {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw new Error('[IpcRouter] Invalid session: Expected SessionState object');
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
    const cleanTranscript: any[] = [];
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
      cleanTranscript.push({
        id: item.id,
        createdAt: item.createdAt,
        relativeMs: item.relativeMs,
        role: item.role,
        status: item.status,
        text: item.text,
        error: typeof item.error === 'string' ? item.error : undefined,
      });
    }

    // Nested messages validation & screenshot stripping
    if (!Array.isArray(sessObj.messages)) {
      throw new Error('[IpcRouter] Invalid session: messages must be an array');
    }
    if (sessObj.messages.length > MAX_MESSAGES_ITEMS) {
      throw new Error(`[IpcRouter] Invalid session: messages exceeds maximum limit of ${MAX_MESSAGES_ITEMS} items`);
    }
    const cleanMessages: any[] = [];
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
      let cleanSources: string[] | undefined = undefined;
      if (msg.sources !== undefined) {
        if (!Array.isArray(msg.sources) || msg.sources.length > 50) {
          throw new Error(`[IpcRouter] Invalid message at index ${i}: sources must be an array under 50 items`);
        }
        cleanSources = [];
        for (const src of msg.sources) {
          if (typeof src !== 'string' || src.length > 500) {
            throw new Error(`[IpcRouter] Invalid source entry at message ${i}: Expected string under 500 chars`);
          }
          cleanSources.push(src);
        }
      }
      // Strip screenshot to keep session record lightweight and free of large base64 binaries
      cleanMessages.push({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        createdAt: msg.createdAt,
        sources: cleanSources,
      });
    }

    const cleanRecord: any = {
      id: sessObj.id,
      createdAt: sessObj.createdAt,
      transcript: cleanTranscript,
      messages: cleanMessages,
    };
    if (sessObj.updatedAt !== undefined) cleanRecord.updatedAt = sessObj.updatedAt;
    if (sessObj.title !== undefined) cleanRecord.title = sessObj.title;
    if (sessObj.durationSeconds !== undefined) cleanRecord.durationSeconds = sessObj.durationSeconds;
    if (sessObj.mode !== undefined) cleanRecord.mode = sessObj.mode;
    if (sessObj.audioInputLanguage !== undefined) cleanRecord.audioInputLanguage = sessObj.audioInputLanguage;
    if (sessObj.summary !== undefined) cleanRecord.summary = sessObj.summary;

    // Aggregate size ceiling: 5MB maximum
    const serialized = JSON.stringify(cleanRecord);
    if (serialized.length > 5 * 1024 * 1024) {
      throw new Error('[IpcRouter] Session record exceeds maximum aggregate size limit of 5MB');
    }

    return cleanRecord;
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
      const currentState = stateManager.getState();
      if (currentState.isPurging) {
        // Prevent renderer updates from restarting capture or recreating private data.
        if (
          rawPatch?.isRecording === true ||
          rawPatch?.meHasVoiceActivity === true ||
          rawPatch?.themHasVoiceActivity === true ||
          (rawPatch?.session !== undefined && rawPatch.session !== null) ||
          (Array.isArray(rawPatch?.knowledgeDocs) && rawPatch.knowledgeDocs.length > 0)
        ) {
          return currentState;
        }
      }
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

    // 8. Window Lifecycle Controls (Minimize & Quit)
    ipcMain.on('minimize-app', (event) => {
      this.validateOrigin(event);
      windowCoordinator.minimizeApp();
    });

    ipcMain.on('quit-app', (event) => {
      this.validateOrigin(event);
      windowCoordinator.quitApp();
    });

    // 9. Secure Credential Vault Handlers
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
      if (stateManager.getState().isPurging) throw new Error('Data purge is in progress; AI requests are temporarily blocked.');
      this.validateAiRequestOptions(options);
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
      const senderWebContents = event.sender;
      const activeRequest = this.activeAiControllers.start(requestId);
      const { operationId, correlationId, controller } = activeRequest;
      let resolveAiTask!: () => void;
      const aiTaskSettled = new Promise<void>(resolve => { resolveAiTask = resolve; });
      this.activeAiTasks.add(aiTaskSettled);
      stateManager.patchState({ isGenerating: true });

      try {
        // Determine required provider
        let providerName = 'gemini';
        if (model && (model.includes('gpt') || model.includes('openai'))) providerName = 'openai';
        else if (model && (model.includes('claude') || model.includes('anthropic'))) providerName = 'anthropic';
        else if (model && model.includes('ollama')) providerName = 'ollama';

        const apiKey = await credentialVault.getKey(providerName);
        if (!apiKey && providerName !== 'ollama') {
          throw new Error(`No API key configured for ${providerName}. Please add it in Settings.`);
        }

        const onToken = (token: string) => {
          if (!stateManager.getState().isPurging && !senderWebContents.isDestroyed()) {
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
            conversationHistory,
            signal: controller.signal,
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
            conversationHistory,
            signal: controller.signal,
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
            conversationHistory,
            signal: controller.signal,
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
            conversationHistory,
            signal: controller.signal,
            onToken,
          });
        }

        return { content: resultText, sources: knowledgePassages };
      } finally {
        this.activeAiControllers.complete(operationId, correlationId);
        this.activeAiTasks.delete(aiTaskSettled);
        resolveAiTask();
        stateManager.patchState({ isGenerating: this.activeAiControllers.size > 0 });
      }
    });

    ipcMain.handle('ai-abort-request', (event, { requestId }: any = {}) => {
      this.validateOrigin(event);
      if (requestId !== undefined && requestId !== null) {
        if (typeof requestId !== 'string') return false;
        const aborted = this.activeAiControllers.abort(requestId);
        stateManager.patchState({ isGenerating: this.activeAiControllers.size > 0 });
        return aborted;
      }
      this.activeAiControllers.abortAll();
      stateManager.patchState({ isGenerating: false });
      return true;
    });

    ipcMain.handle('purge-all-data', async event => {
      this.validateOrigin(event);
      if (stateManager.getState().isPurging) throw new Error('A data purge is already in progress.');

      // Close the write gate before notifying renderers or deleting persistent files.
      stateManager.patchState({
        isPurging: true,
        isRecording: false,
        meHasVoiceActivity: false,
        themHasVoiceActivity: false,
        isGenerating: false,
      });

      this.activeAiControllers.abortAll();
      for (const controller of this.activeTranscriptionControllers) controller.abort();

      try {
        // Wait for aborted AI and STT handlers to leave their finally blocks before
        // deleting credentials and local data. Their providers receive the AbortSignal.
        await Promise.allSettled([
          ...Array.from(this.activeAiTasks),
          ...Array.from(this.activeTranscriptionTasks),
        ]);
        await credentialVault.deleteAllKeys();
        await sessionRepository.purgeAll();

        stateManager.patchState({
          hasApiKeys: {
            gemini: false,
            openai: false,
            anthropic: false,
            groq: false,
            ollama: false,
          },
          session: null,
          knowledgeDocs: [],
          isRecording: false,
          isGenerating: false,
          isPurging: false,
        });
        stateManager.flushSaveOrThrow();
        return true;
      } catch (error) {
        stateManager.patchState({ isPurging: false, isRecording: false });
        try {
          stateManager.flushSaveOrThrow();
        } catch (saveError) {
          console.error('[IpcRouter] Failed to persist purge failure state:', saveError);
        }
        throw error;
      }
    });

    // 10. STT Transcription Bridge
    ipcMain.handle('stt-transcribe-payload', async (event, { wavBase64, language }: any) => {
      this.validateOrigin(event);
      if (stateManager.getState().isPurging) throw new Error('Data purge is in progress; transcription is blocked.');
      if (!wavBase64 || typeof wavBase64 !== 'string') throw new Error('Missing wavBase64 audio payload');
      if (wavBase64.length > MAX_STT_AUDIO_BASE64_CHARS) {
        throw new Error('Audio payload exceeds the 8 MiB encoded size limit');
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(wavBase64) || wavBase64.length % 4 !== 0) {
        throw new Error('Audio payload is not valid base64');
      }

      const groqKey = await credentialVault.getKey('groq');
      const openaiKey = await credentialVault.getKey('openai');
      const activeKey = groqKey || openaiKey;
      const provider = groqKey ? 'groq' : 'openai';
      if (!activeKey) throw new Error('No Speech-to-Text key configured. Set Groq or OpenAI key in Settings.');
      if (stateManager.getState().isPurging) throw new Error('Data purge is in progress; transcription is blocked.');

      const buf = this.validateSttAudioPayload(wavBase64);
      const audioBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const controller = new AbortController();
      this.activeTranscriptionControllers.add(controller);
      const task = transcribeAudio(audioBuffer, activeKey, provider, language || 'en', controller.signal);
      this.activeTranscriptionTasks.add(task);
      try {
        const text = await task;
        if (stateManager.getState().isPurging) throw new Error('Transcription discarded because data purge started.');
        return { text };
      } finally {
        this.activeTranscriptionControllers.delete(controller);
        this.activeTranscriptionTasks.delete(task);
      }
    });

    // 11. Multi-Session Repository Handlers
    ipcMain.handle('session-save', async (event, session: any) => {
      this.validateOrigin(event);
      if (stateManager.getState().isPurging) throw new Error('Data purge is in progress; session writes are blocked.');
      const cleanSession = this.sanitizeSessionRecord(session);
      await sessionRepository.saveSession(cleanSession);
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
      broadcastSharedStateToAppWindows(windowCoordinator, state);
    });
  }
}

export const ipcRouter = new IpcRouter();
