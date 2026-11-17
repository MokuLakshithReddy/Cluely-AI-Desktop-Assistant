import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';

export type RealtimeSTTStatus =
  | 'not_configured'
  | 'downloading'
  | 'initializing'
  | 'ready'
  | 'capturing'
  | 'transcribing'
  | 'paused'
  | 'stopped'
  | 'error'
  | 'alive';

export interface RealtimeSTTEvent {
  type: 'interim' | 'stabilized' | 'final' | 'status' | 'error' | 'pong';
  text?: string;
  status?: RealtimeSTTStatus;
  model?: string;
  message?: string;
  error?: string;
  code?: string;
  timestamp?: number;
}

export interface CachedModelInfo {
  id: string;
  name: string;
  sizeBytes: number;
  sizeMb: string;
  path: string;
  isActive: boolean;
}

const MAX_AUDIO_QUEUE = 100; // Maximum queued audio frames (~10-20 seconds) before dropping oldest

export class RealtimeSTTManager {
  private child: ChildProcess | null = null;
  private status: RealtimeSTTStatus = 'not_configured';
  private currentModel: string = 'tiny.en';
  private rl: readline.Interface | null = null;
  private interimListeners: Array<(text: string, timestamp: number) => void> = [];
  private stabilizedListeners: Array<(text: string, timestamp: number) => void> = [];
  private finalListeners: Array<(text: string, timestamp: number) => void> = [];
  private statusListeners: Array<(status: RealtimeSTTStatus, message?: string, code?: string) => void> = [];
  private modelsDir: string;
  private sidecarScriptPath: string;

  // Concurrency & Lifecycle Mutex
  private startPromise: Promise<boolean> | null = null;
  private pendingModel: string | null = null;
  private isShuttingDown: boolean = false;
  private isExpectedExit: boolean = false;
  private initTimeoutHandle: NodeJS.Timeout | null = null;

  // Audio queue and backpressure handling
  private audioQueue: string[] = [];
  private isDraining: boolean = false;

  constructor() {
    const isPackaged = typeof app !== 'undefined' && app.isPackaged;
    const userData = typeof app !== 'undefined' && typeof app.getPath === 'function'
      ? app.getPath('userData')
      : path.join(process.cwd(), '.tmp-scandium');

    this.modelsDir = path.join(userData, 'realtime-models');
    try {
      fs.mkdirSync(this.modelsDir, { recursive: true });
    } catch {}

    const appRoot = typeof app !== 'undefined' && typeof app.getAppPath === 'function'
      ? app.getAppPath()
      : process.cwd();

    this.sidecarScriptPath = isPackaged
      ? path.join(process.resourcesPath, 'python-stt', 'scandium_stt_sidecar.py')
      : path.join(appRoot, 'python-stt', 'scandium_stt_sidecar.py');
  }

  /**
   * Resolves the portable Python executable.
   * In packaged mode, strictly requires the bundled runtime under process.resourcesPath.
   * In development mode, checks explicit environment variables, virtualenv, and system PATH.
   */
  public resolvePythonExecutable(): string | null {
    // 1. Packaged python runtime if embedded
    if (typeof app !== 'undefined' && app.isPackaged) {
      const candidates = process.platform === 'win32'
        ? [
            path.join(process.resourcesPath, 'python', 'python.exe'),
            path.join(process.resourcesPath, 'python', 'Scripts', 'python.exe'),
          ]
        : [
            path.join(process.resourcesPath, 'python', 'bin', 'python3'),
            path.join(process.resourcesPath, 'python', 'bin', 'python'),
          ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
      return null; // Strict: Do NOT silently fallback to arbitrary system Python in packaged mode!
    }

    // 2. Explicit environment variable override
    if (process.env.SCANDIUM_PYTHON_PATH && fs.existsSync(process.env.SCANDIUM_PYTHON_PATH)) {
      return process.env.SCANDIUM_PYTHON_PATH;
    }

    // 3. Local virtual environment in project root or app root
    const devCandidates = process.platform === 'win32'
      ? [
          path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
          path.join(process.cwd(), 'app', 'resources', 'python', 'Scripts', 'python.exe'),
          path.join(process.cwd(), 'app', 'resources', 'python', 'python.exe'),
        ]
      : [
          path.join(process.cwd(), '.venv', 'bin', 'python3'),
          path.join(process.cwd(), 'app', 'resources', 'python', 'bin', 'python3'),
        ];
    for (const candidate of devCandidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // 4. In development only: fallback to PATH
    return process.platform === 'win32' ? 'python.exe' : 'python3';
  }

  public getStatus(): { status: RealtimeSTTStatus; model: string; modelsDir: string } {
    return {
      status: this.status,
      model: this.currentModel,
      modelsDir: this.modelsDir,
    };
  }

  public onInterim(cb: (text: string, timestamp: number) => void): () => void {
    this.interimListeners.push(cb);
    return () => {
      this.interimListeners = this.interimListeners.filter(l => l !== cb);
    };
  }

  public onStabilized(cb: (text: string, timestamp: number) => void): () => void {
    this.stabilizedListeners.push(cb);
    return () => {
      this.stabilizedListeners = this.stabilizedListeners.filter(l => l !== cb);
    };
  }

  public onFinal(cb: (text: string, timestamp: number) => void): () => void {
    this.finalListeners.push(cb);
    return () => {
      this.finalListeners = this.finalListeners.filter(l => l !== cb);
    };
  }

  public onStatus(cb: (status: RealtimeSTTStatus, message?: string, code?: string) => void): () => void {
    this.statusListeners.push(cb);
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== cb);
    };
  }

  private broadcastToWindows(channel: string, payload: any): void {
    if (typeof BrowserWindow === 'undefined') return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }

  private setStatus(status: RealtimeSTTStatus, message?: string, code?: string): void {
    this.status = status;
    for (const cb of this.statusListeners) {
      try { cb(status, message, code); } catch {}
    }
    this.broadcastToWindows('realtime-stt-status', {
      status,
      model: this.currentModel,
      message,
      code,
    });
  }

  private normalizeTimestamp(rawTs?: number): number {
    if (!rawTs) return Date.now();
    // Convert seconds (e.g. 1731777200) to milliseconds if needed
    return Math.round(rawTs < 1e11 ? rawTs * 1000 : rawTs);
  }

  /**
   * Starts or restarts the RealtimeSTT Python sidecar with the requested model profile.
   * Serialized via single-flight mutex to prevent concurrent process spawn races.
   */
  public async start(model: string = 'tiny.en'): Promise<boolean> {
    if (this.isShuttingDown) {
      return false;
    }

    // Fast synthetic mode for headless unit testing when sidecar is not explicitly requested
    if (process.env.VITEST === 'true' && process.env.ENABLE_REAL_STT_TEST !== 'true') {
      this.currentModel = model;
      this.setStatus('ready', `Synthetic test STT initialized with ${model}`);
      return true;
    }

    // Return active single-flight promise if the same model startup is currently in flight.
    // If a different model is requested, await completion of the in-flight startup then switch models.
    if (this.startPromise) {
      if (this.pendingModel === model) {
        return this.startPromise;
      }
      try {
        await this.startPromise;
      } catch {}
      return this.start(model);
    }

    this.pendingModel = model;
    this.startPromise = this.performStart(model);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
      this.pendingModel = null;
    }
  }

  private async performStart(model: string): Promise<boolean> {
    // If already running with the exact same model and in ready state, reuse
    if (this.child && !this.child.killed && this.status === 'ready' && this.currentModel === model) {
      return true;
    }

    // If running with a different model or in error state, stop the existing child first
    if (this.child && !this.child.killed) {
      await this.stop();
    }

    const pythonBin = this.resolvePythonExecutable();
    if (!pythonBin) {
      const err = typeof app !== 'undefined' && app.isPackaged
        ? 'Bundled Python speech runtime not found in application package. Please reinstall Scandium.'
        : 'Python 3.10-3.12 executable not found. Ensure Python is installed or set SCANDIUM_PYTHON_PATH.';
      this.setStatus('error', err, 'PYTHON_NOT_FOUND');
      return false;
    }

    this.currentModel = model;
    this.setStatus('initializing', `Launching RealtimeSTT sidecar with ${model}...`);
    this.audioQueue = [];
    this.isExpectedExit = false;

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const finish = (success: boolean) => {
        if (resolved) return;
        resolved = true;
        if (this.initTimeoutHandle) {
          clearTimeout(this.initTimeoutHandle);
          this.initTimeoutHandle = null;
        }
        resolve(success);
      };

      try {
        this.child = spawn(pythonBin, [this.sidecarScriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
          },
        });

        if (!this.child || !this.child.stdout || !this.child.stdin) {
          this.setStatus('error', 'Failed to create IPC pipes to Python sidecar.', 'PIPE_CREATION_FAILED');
          finish(false);
          return;
        }

        this.rl = readline.createInterface({
          input: this.child.stdout,
          crlfDelay: Infinity,
        });

        this.rl.on('line', (line) => {
          line = line.trim();
          if (!line) return;
          try {
            const data = JSON.parse(line) as RealtimeSTTEvent;

            if (data.type === 'status') {
              if (data.status === 'alive') {
                // Handshake acknowledged: request model initialization
                this.child?.stdin?.write(JSON.stringify({
                  type: 'init',
                  model: this.currentModel,
                  download_root: this.modelsDir,
                }) + '\n');
              } else if (data.status === 'downloading') {
                this.setStatus('downloading', data.message || `Downloading speech model ${this.currentModel}...`);
              } else if (data.status === 'initializing') {
                this.setStatus('initializing', data.message || `Loading speech model ${this.currentModel}...`);
              } else if (data.status === 'ready') {
                this.setStatus('ready', data.message);
                finish(true);
              } else if (data.status === 'error') {
                const errMsg = data.message || data.error || 'Sidecar initialization error';
                this.setStatus('error', errMsg, data.code || 'INIT_ERROR');
                finish(false);
              }
            } else if (data.type === 'interim' && data.text) {
              const ts = this.normalizeTimestamp(data.timestamp);
              for (const cb of this.interimListeners) {
                try { cb(data.text, ts); } catch {}
              }
              this.broadcastToWindows('realtime-stt-interim', { text: data.text, timestamp: ts });
            } else if (data.type === 'stabilized' && data.text) {
              const ts = this.normalizeTimestamp(data.timestamp);
              for (const cb of this.stabilizedListeners) {
                try { cb(data.text, ts); } catch {}
              }
              this.broadcastToWindows('realtime-stt-stabilized', { text: data.text, timestamp: ts });
            } else if (data.type === 'final' && data.text) {
              const ts = this.normalizeTimestamp(data.timestamp);
              for (const cb of this.finalListeners) {
                try { cb(data.text, ts); } catch {}
              }
              this.broadcastToWindows('realtime-stt-final', { text: data.text, timestamp: ts });
            } else if (data.type === 'error') {
              const errMsg = data.message || data.error || 'Speech sidecar runtime error';
              this.setStatus('error', errMsg, data.code);
            }
          } catch {
            // Non-JSON diagnostic output from underlying C/Python libraries
          }
        });

        this.child.stderr?.on('data', (chunk) => {
          const text = chunk.toString();
          if (text.includes('Traceback') || text.includes('Error')) {
            console.error('[RealtimeSTT Sidecar stderr]:', text.trim());
          }
        });

        this.child.on('error', (err) => {
          console.error('[RealtimeSTT] Process spawn error:', err);
          this.setStatus('error', err.message, 'SPAWN_ERROR');
          finish(false);
        });

        this.child.on('close', (code, signal) => {
          if (!this.isExpectedExit) {
            console.warn(`[RealtimeSTT] Process terminated unexpectedly with code ${code}, signal ${signal}`);
            this.setStatus('error', `Speech engine stopped unexpectedly (exit code ${code}).`, 'UNEXPECTED_EXIT');
          } else {
            this.setStatus('stopped', `Speech engine stopped cleanly.`);
          }
          this.child = null;
          this.rl = null;
          this.audioQueue = [];
          this.isDraining = false;
          finish(false);
        });

        // First-time model downloads can take up to 120 seconds on modest internet connections
        this.initTimeoutHandle = setTimeout(() => {
          if (!resolved) {
            console.error('[RealtimeSTT] Timed out waiting for sidecar initialization.');
            this.setStatus('error', 'Timed out waiting for speech engine initialization.', 'TIMEOUT');
            try { this.child?.kill('SIGKILL'); } catch {}
            finish(false);
          }
        }, 120000);

      } catch (err: any) {
        this.setStatus('error', err?.message || 'Failed to spawn Python sidecar', 'EXCEPTION');
        finish(false);
      }
    });
  }

  /**
   * Pauses transcription without terminating the sidecar process.
   */
  public pause(): void {
    if (process.env.VITEST === 'true' && process.env.ENABLE_REAL_STT_TEST !== 'true') {
      this.setStatus('paused', 'Synthetic test STT paused');
      return;
    }
    if (this.child && !this.child.killed && this.child.stdin && this.status === 'ready') {
      try {
        this.child.stdin.write(JSON.stringify({ type: 'pause' }) + '\n');
        this.setStatus('paused', 'Transcription paused');
      } catch {}
    }
  }

  /**
   * Resumes transcription from paused state.
   */
  public resume(): void {
    if (process.env.VITEST === 'true' && process.env.ENABLE_REAL_STT_TEST !== 'true') {
      this.setStatus('ready', 'Synthetic test STT resumed');
      return;
    }
    if (this.child && !this.child.killed && this.child.stdin && this.status === 'paused') {
      try {
        this.child.stdin.write(JSON.stringify({ type: 'resume' }) + '\n');
        this.setStatus('ready', 'Transcription resumed');
      } catch {}
    }
  }

  /**
   * Feeds raw PCM audio chunk (16-bit 16kHz mono) to the RealtimeSTT sidecar.
   * Implements strict backpressure handling with a bounded audio queue.
   */
  public feedAudioChunk(chunk: Buffer | string): void {
    if (this.isShuttingDown || !this.child || this.child.killed || !this.child.stdin || this.status !== 'ready') {
      return;
    }

    const base64Data = typeof chunk === 'string' ? chunk : chunk.toString('base64');

    // Handle bounded queue to prevent memory blowup during heavy backpressure
    if (this.audioQueue.length >= MAX_AUDIO_QUEUE) {
      // Discard oldest frame to keep memory bounded and prevent latency buildup
      this.audioQueue.shift();
    }
    this.audioQueue.push(base64Data);

    this.processAudioQueue();
  }

  private processAudioQueue(): void {
    if (this.isDraining || this.audioQueue.length === 0 || !this.child?.stdin) {
      return;
    }

    while (this.audioQueue.length > 0) {
      const nextChunk = this.audioQueue.shift();
      if (!nextChunk) continue;

      const payload = JSON.stringify({ type: 'feed', data: nextChunk }) + '\n';
      const canContinue = this.child.stdin.write(payload);

      if (!canContinue) {
        this.isDraining = true;
        this.child.stdin.once('drain', () => {
          this.isDraining = false;
          this.processAudioQueue();
        });
        break;
      }
    }
  }

  /**
   * Feeds silence to prompt VAD segment finalization.
   */
  public feedSilence(durationSeconds: number = 1.0): void {
    if (this.child && !this.child.killed && this.child.stdin) {
      try {
        this.child.stdin.write(JSON.stringify({
          type: 'feed_silence',
          duration: durationSeconds,
        }) + '\n');
      } catch {}
    }
  }

  /**
   * Gracefully shuts down the sidecar process.
   */
  public async stop(): Promise<void> {
    if (process.env.VITEST === 'true' && process.env.ENABLE_REAL_STT_TEST !== 'true') {
      this.setStatus('stopped', 'Synthetic test STT stopped');
      return;
    }
    if (!this.child || this.child.killed) {
      this.setStatus('stopped', 'Sidecar already stopped');
      return;
    }

    this.isExpectedExit = true;
    this.audioQueue = [];

    return new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        try { this.child?.kill('SIGKILL'); } catch {}
        this.child = null;
        this.rl = null;
        this.setStatus('stopped', 'Sidecar forcibly terminated');
        resolve();
      }, 3000);

      try {
        this.child?.stdin?.write(JSON.stringify({ type: 'shutdown' }) + '\n');
        this.child?.once('close', () => {
          clearTimeout(forceTimer);
          this.child = null;
          this.rl = null;
          this.setStatus('stopped', 'Sidecar stopped cleanly');
          resolve();
        });
      } catch {
        clearTimeout(forceTimer);
        try { this.child?.kill('SIGKILL'); } catch {}
        this.child = null;
        this.rl = null;
        this.setStatus('stopped');
        resolve();
      }
    });
  }

  /**
   * Explicit application-exit shutdown handler.
   */
  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    await this.stop();
  }

  /**
   * Returns metadata and disk usage of cached speech models.
   */
  public async getModelsInfo(): Promise<CachedModelInfo[]> {
    const results: CachedModelInfo[] = [];
    if (!fs.existsSync(this.modelsDir)) return results;

    try {
      const entries = fs.readdirSync(this.modelsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(this.modelsDir, entry.name);
          let totalBytes = 0;
          try {
            const files = fs.readdirSync(dirPath);
            for (const f of files) {
              const stat = fs.statSync(path.join(dirPath, f));
              totalBytes += stat.size;
            }
          } catch {}

          const mb = (totalBytes / (1024 * 1024)).toFixed(1);
          results.push({
            id: entry.name,
            name: entry.name,
            sizeBytes: totalBytes,
            sizeMb: `${mb} MB`,
            path: dirPath,
            isActive: entry.name.includes(this.currentModel) && this.status === 'ready',
          });
        }
      }
    } catch (err) {
      console.error('[RealtimeSTT] Error scanning model cache:', err);
    }

    return results;
  }

  /**
   * Deletes a cached model from the local filesystem.
   * Refuses to delete the currently loaded active model.
   */
  public async deleteModel(modelId: string): Promise<{ success: boolean; message: string }> {
    if (this.currentModel === modelId && (this.status === 'ready' || this.status === 'initializing')) {
      return { success: false, message: `Cannot delete model ${modelId} while it is actively in use.` };
    }

    const safeId = path.basename(modelId);
    const targetDir = path.join(this.modelsDir, safeId);

    if (!fs.existsSync(targetDir)) {
      return { success: false, message: `Model directory not found: ${modelId}` };
    }

    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return { success: true, message: `Model ${modelId} deleted successfully.` };
    } catch (err: any) {
      return { success: false, message: `Failed to delete model: ${err.message}` };
    }
  }
}

export const realtimeSTTManager = new RealtimeSTTManager();
