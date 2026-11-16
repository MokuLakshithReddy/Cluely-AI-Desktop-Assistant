import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';

export type RealtimeSTTStatus =
  | 'alive'
  | 'not_configured'
  | 'downloading'
  | 'initializing'
  | 'ready'
  | 'capturing'
  | 'transcribing'
  | 'paused'
  | 'stopped'
  | 'error';

export interface RealtimeSTTEvent {
  type: 'interim' | 'stabilized' | 'final' | 'status' | 'error';
  text?: string;
  status?: RealtimeSTTStatus;
  model?: string;
  message?: string;
  timestamp?: number;
}

export class RealtimeSTTManager {
  private child: ChildProcess | null = null;
  private status: RealtimeSTTStatus = 'not_configured';
  private currentModel: string = 'tiny.en';
  private rl: readline.Interface | null = null;
  private interimListeners: Array<(text: string, timestamp: number) => void> = [];
  private finalListeners: Array<(text: string, timestamp: number) => void> = [];
  private statusListeners: Array<(status: RealtimeSTTStatus, message?: string) => void> = [];
  private modelsDir: string;
  private sidecarScriptPath: string;

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
   * Resolves the python executable to use for the sidecar.
   */
  public resolvePythonExecutable(): string | null {
    // 1. Packaged python runtime if embedded
    if (typeof app !== 'undefined' && app.isPackaged) {
      const bundled = path.join(process.resourcesPath, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
      if (fs.existsSync(bundled)) return bundled;
    }

    // 2. Local virtual environment in project root
    const venvWin = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvWin)) return venvWin;
    const venvUnix = path.join(process.cwd(), '.venv', 'bin', 'python3');
    if (fs.existsSync(venvUnix)) return venvUnix;

    // 3. System Windows Python 3.12 default install path
    const win312 = 'C:\\Users\\nsrfl\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
    if (fs.existsSync(win312)) return win312;

    // 4. Fallback to PATH environment
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

  public onFinal(cb: (text: string, timestamp: number) => void): () => void {
    this.finalListeners.push(cb);
    return () => {
      this.finalListeners = this.finalListeners.filter(l => l !== cb);
    };
  }

  public onStatus(cb: (status: RealtimeSTTStatus, message?: string) => void): () => void {
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

  private setStatus(status: RealtimeSTTStatus, message?: string): void {
    this.status = status;
    for (const cb of this.statusListeners) {
      try { cb(status, message); } catch {}
    }
    this.broadcastToWindows('realtime-stt-status', { status, model: this.currentModel, message });
  }

  /**
   * Starts the RealtimeSTT Python sidecar process and initializes the specified model.
   */
  public async start(model: string = 'tiny.en'): Promise<boolean> {
    if (process.env.VITEST === 'true') {
      // Fast synthetic mode for headless unit testing
      this.currentModel = model;
      this.setStatus('ready', `Synthetic test STT initialized with ${model}`);
      return true;
    }

    if (this.child && !this.child.killed && this.status === 'ready') {
      if (this.currentModel === model) {
        return true;
      }
      await this.stop();
    }

    const pythonBin = this.resolvePythonExecutable();
    if (!pythonBin) {
      this.setStatus('error', 'Python executable not found. Install Python 3.10-3.12.');
      return false;
    }

    this.setStatus('initializing', `Launching RealtimeSTT sidecar with ${model}...`);
    this.currentModel = model;

    return new Promise<boolean>((resolve) => {
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
          this.setStatus('error', 'Failed to create IPC pipes to Python sidecar.');
          resolve(false);
          return;
        }

        this.rl = readline.createInterface({
          input: this.child.stdout,
          crlfDelay: Infinity,
        });

        let initialized = false;

        this.rl.on('line', (line) => {
          line = line.trim();
          if (!line) return;
          try {
            const data = JSON.parse(line) as RealtimeSTTEvent;
            if (data.type === 'status') {
              if (data.status === 'alive') {
                // Send init command once sidecar signals it is alive
                this.child?.stdin?.write(JSON.stringify({
                  type: 'init',
                  model: this.currentModel,
                  download_root: this.modelsDir,
                }) + '\n');
              } else if (data.status === 'ready') {
                this.setStatus('ready', data.message);
                if (!initialized) {
                  initialized = true;
                  resolve(true);
                }
              } else if (data.status === 'error') {
                this.setStatus('error', data.message || 'Sidecar error');
                if (!initialized) {
                  initialized = true;
                  resolve(false);
                }
              }
            } else if (data.type === 'interim' && data.text) {
              const ts = data.timestamp || Date.now();
              for (const cb of this.interimListeners) {
                try { cb(data.text, ts); } catch {}
              }
              this.broadcastToWindows('realtime-stt-interim', { text: data.text, timestamp: ts });
            } else if (data.type === 'final' && data.text) {
              const ts = data.timestamp || Date.now();
              for (const cb of this.finalListeners) {
                try { cb(data.text, ts); } catch {}
              }
              this.broadcastToWindows('realtime-stt-final', { text: data.text, timestamp: ts });
            }
          } catch {
            // Non-JSON diagnostic logs from python libraries
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
          this.setStatus('error', err.message);
          if (!initialized) {
            initialized = true;
            resolve(false);
          }
        });

        this.child.on('close', (code) => {
          this.setStatus('stopped', `Process exited with code ${code}`);
          this.child = null;
          this.rl = null;
        });

        // Timeout fallback after 30 seconds
        setTimeout(() => {
          if (!initialized) {
            initialized = true;
            this.setStatus('error', 'Timed out waiting for RealtimeSTT initialization');
            resolve(false);
          }
        }, 30000);

      } catch (err: any) {
        this.setStatus('error', err?.message || 'Failed to spawn Python sidecar');
        resolve(false);
      }
    });
  }

  /**
   * Feeds raw PCM audio chunk (16-bit 16kHz mono) to the RealtimeSTT sidecar.
   * Can accept either a Buffer or base64-encoded string.
   */
  public feedAudioChunk(chunk: Buffer | string): void {
    if (process.env.VITEST === 'true') {
      return;
    }
    if (!this.child || this.child.killed || !this.child.stdin || this.status !== 'ready') {
      return;
    }
    try {
      const base64Data = typeof chunk === 'string' ? chunk : chunk.toString('base64');
      this.child.stdin.write(JSON.stringify({
        type: 'feed',
        data: base64Data,
      }) + '\n');
    } catch (e) {
      console.error('[RealtimeSTT] Error feeding chunk:', e);
    }
  }

  /**
   * Feeds a brief duration of silence to flush speech and force final sentence emission.
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
    if (process.env.VITEST === 'true') {
      this.setStatus('stopped', 'Synthetic test STT stopped');
      return;
    }
    if (!this.child || this.child.killed) {
      this.setStatus('stopped', 'Sidecar already stopped');
      return;
    }

    return new Promise((resolve) => {
      const cleanupTimer = setTimeout(() => {
        try { this.child?.kill('SIGKILL'); } catch {}
        this.child = null;
        this.rl = null;
        this.setStatus('stopped', 'Sidecar forced closed');
        resolve();
      }, 3000);

      try {
        this.child?.stdin?.write(JSON.stringify({ type: 'shutdown' }) + '\n');
        this.child?.once('close', () => {
          clearTimeout(cleanupTimer);
          this.child = null;
          this.rl = null;
          this.setStatus('stopped', 'Sidecar stopped cleanly');
          resolve();
        });
      } catch {
        clearTimeout(cleanupTimer);
        try { this.child?.kill(); } catch {}
        this.child = null;
        this.rl = null;
        this.setStatus('stopped');
        resolve();
      }
    });
  }
}

export const realtimeSTTManager = new RealtimeSTTManager();
