import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import https from 'https';
import { spawn } from 'child_process';
import { app } from 'electron';

export interface WhisperModelInfo {
  id: string;
  name: string;
  filename: string;
  sizeBytes: number;
  url: string;
  sha256: string;
  isDownloaded: boolean;
}

export const WHISPER_MODELS: Record<string, WhisperModelInfo> = {
  'ggml-tiny.en': {
    id: 'ggml-tiny.en',
    name: 'Whisper Tiny (English, ~75MB)',
    filename: 'ggml-tiny.en.bin',
    sizeBytes: 77704715,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    isDownloaded: false,
  },
  'ggml-base.en': {
    id: 'ggml-base.en',
    name: 'Whisper Base (English, ~142MB)',
    filename: 'ggml-base.en.bin',
    sizeBytes: 147964211,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    isDownloaded: false,
  },
};

export const WHISPER_TEMP_DIR_PREFIX = 'scandium-stt-';
export const LEGACY_WHISPER_TEMP_PREFIX = 'scandium_stt_';

/**
 * Builds whisper-cli arguments for stdout-only transcription.
 * Explicitly omits -otxt / --output-txt so plaintext transcripts are never written to disk.
 */
export function buildWhisperCliArgs(modelPath: string, tempAudioPath: string, language: string): string[] {
  return [
    '--model', modelPath,
    '-f', tempAudioPath,
    '--language', language,
    '-nt', // no timestamps
    '-np', // suppress timing/progress logs; print clean transcript to stdout only
  ];
}

export class WhisperRuntime {
  private modelsDir: string;
  private activeModelId = 'ggml-tiny.en';
  private downloadingModelId: string | null = null;
  private downloadProgress = 0;
  private activeTempDirs = new Set<string>();
  private exitHookRegistered = false;
  private transcriptionQueue: Array<{
    wavBuffer: ArrayBuffer;
    language: string;
    signal?: AbortSignal;
    resolve: (text: string) => void;
    reject: (err: any) => void;
  }> = [];
  private isProcessingQueue = false;

  constructor() {
    const baseDir = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.scandium');
    this.modelsDir = path.join(baseDir, 'whisper-models');
    try {
      if (!fs.existsSync(this.modelsDir)) {
        fs.mkdirSync(this.modelsDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[WhisperRuntime] Failed to create models directory:', e);
    }
    if (process.env.VITEST !== 'true') {
      this.cleanupOrphanedTempFiles();
    }
  }

  private registerExitCleanupHook(): void {
    if (this.exitHookRegistered) return;
    this.exitHookRegistered = true;
    process.once('exit', () => {
      for (const dir of Array.from(this.activeTempDirs)) {
        this.secureRemoveTempDir(dir);
      }
    });
  }

  private secureUnlinkFile(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && stat.size > 0 && stat.size <= 32 * 1024 * 1024) {
        try {
          fs.writeFileSync(filePath, Buffer.alloc(stat.size), { mode: 0o600 });
        } catch {}
      }
      fs.unlinkSync(filePath);
    } catch {}
  }

  private secureRemoveTempDir(tempDir: string, retriesLeft = 3): void {
    try {
      if (!fs.existsSync(tempDir)) {
        this.activeTempDirs.delete(tempDir);
        return;
      }
      const entries = fs.readdirSync(tempDir);
      for (const entry of entries) {
        const fullPath = path.join(tempDir, entry);
        try {
          const stat = fs.lstatSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            this.secureUnlinkFile(fullPath);
          }
        } catch {}
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    if (!fs.existsSync(tempDir)) {
      this.activeTempDirs.delete(tempDir);
    } else if (retriesLeft > 0) {
      // On Windows, a forcibly killed child process may briefly hold a file handle (EBUSY).
      const timer = setTimeout(() => this.secureRemoveTempDir(tempDir, retriesLeft - 1), 100);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // EPERM means the process exists but belongs to another user/privilege level.
      return err?.code === 'EPERM';
    }
  }

  /**
   * Sweeps any orphaned Scandium Whisper temp directories or legacy scandium_stt_* files
   * left behind by a crash, forced kill, or older application version.
   * Respects PID-tagged directories owned by other currently running processes.
   */
  public cleanupOrphanedTempFiles(baseTmpDir: string = os.tmpdir()): number {
    let removed = 0;
    try {
      if (!fs.existsSync(baseTmpDir)) return 0;
      const entries = fs.readdirSync(baseTmpDir);
      for (const entry of entries) {
        const fullPath = path.join(baseTmpDir, entry);
        if (entry.startsWith(WHISPER_TEMP_DIR_PREFIX) && !this.activeTempDirs.has(fullPath)) {
          const pidMatch = /^scandium-stt-p(\d+)-/.exec(entry);
          if (pidMatch) {
            const ownerPid = Number(pidMatch[1]);
            if (ownerPid !== process.pid && this.isProcessAlive(ownerPid)) {
              continue; // Belongs to another active process; do not disrupt live transcription
            }
          }
          this.secureRemoveTempDir(fullPath);
          removed++;
        } else if (entry.startsWith(LEGACY_WHISPER_TEMP_PREFIX)) {
          this.secureUnlinkFile(fullPath);
          removed++;
        }
      }
    } catch {}
    return removed;
  }

  public getModels(): WhisperModelInfo[] {
    return Object.values(WHISPER_MODELS).map(m => {
      const exists = this.isModelDownloaded(m.id);
      return { ...m, isDownloaded: exists };
    });
  }

  public getActiveModelId(): string {
    return this.activeModelId;
  }

  public setActiveModel(modelId: string) {
    if (WHISPER_MODELS[modelId]) {
      this.activeModelId = modelId;
    }
  }

  public resolveModelPath(modelId: string): string | null {
    const info = WHISPER_MODELS[modelId];
    if (!info) return null;

    const candidates = [
      path.join(this.modelsDir, info.filename),
      path.join(process.cwd(), 'resources', 'whisper', info.filename),
      path.join(process.cwd(), 'app', 'resources', 'whisper', info.filename),
      path.join(__dirname, '..', '..', 'resources', 'whisper', info.filename),
    ];

    if ((process as any).resourcesPath) {
      candidates.unshift(path.join((process as any).resourcesPath, 'whisper', info.filename));
    }

    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).size > 1000000) {
        return c;
      }
    }

    return null;
  }

  public isModelDownloaded(modelId: string): boolean {
    return this.resolveModelPath(modelId) !== null;
  }

  public getDownloadStatus() {
    return {
      downloadingModelId: this.downloadingModelId,
      progress: this.downloadProgress,
    };
  }

  public async downloadModel(
    modelId: string,
    onProgress?: (percent: number) => void
  ): Promise<boolean> {
    const info = WHISPER_MODELS[modelId];
    if (!info) throw new Error(`Unknown model ID: ${modelId}`);

    if (this.isModelDownloaded(modelId)) return true;
    if (this.downloadingModelId) throw new Error(`Another model is currently downloading: ${this.downloadingModelId}`);

    this.downloadingModelId = modelId;
    this.downloadProgress = 0;
    const destPath = path.join(this.modelsDir, info.filename);
    const tempPath = destPath + '.download';

    try {
      await this.downloadFile(info.url, tempPath, (downloaded, total) => {
        const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        this.downloadProgress = percent;
        onProgress?.(percent);
      });

      // Verify file size
      const stats = fs.statSync(tempPath);
      if (stats.size < 1000000) {
        throw new Error('Downloaded model file is suspiciously small or corrupted');
      }

      // Verify SHA-256 checksum
      if (info.sha256) {
        const computedSha256 = await this.computeFileSha256(tempPath);
        if (computedSha256.toLowerCase() !== info.sha256.toLowerCase()) {
          throw new Error(`Model SHA-256 verification failed (expected: ${info.sha256}, got: ${computedSha256})`);
        }
      }

      fs.renameSync(tempPath, destPath);
      this.downloadingModelId = null;
      this.downloadProgress = 100;
      return true;
    } catch (err) {
      this.downloadingModelId = null;
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw err;
    }
  }

  public computeFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private downloadFile(
    urlStr: string,
    destPath: string,
    onProgress: (downloaded: number, total: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const handleRequest = (currentUrl: string) => {
        const parsed = new URL(currentUrl);
        https.get(
          {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: { 'User-Agent': 'Scandium-Desktop/1.0.2' },
          },
          res => {
            // Follow redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              const redirectUrl = new URL(res.headers.location, currentUrl).href;
              return handleRequest(redirectUrl);
            }

            if (res.statusCode !== 200) {
              file.close();
              return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
            }

            const total = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;

            res.on('data', chunk => {
              downloaded += chunk.length;
              file.write(chunk);
              onProgress(downloaded, total);
            });

            res.on('end', () => {
              file.end();
              resolve();
            });

            res.on('error', err => {
              file.close();
              reject(err);
            });
          }
        ).on('error', err => {
          file.close();
          reject(err);
        });
      };

      handleRequest(urlStr);
    });
  }

  public transcribeAudio(
    wavBuffer: ArrayBuffer,
    language = 'en',
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.transcriptionQueue.push({
        wavBuffer,
        language,
        signal,
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.transcriptionQueue.length > 0) {
      const task = this.transcriptionQueue.shift();
      if (!task) break;

      if (task.signal?.aborted) {
        task.reject(new Error('Transcription cancelled'));
        continue;
      }

      try {
        const text = await this.executeTranscription(task.wavBuffer, task.language, task.signal);
        task.resolve(text);
      } catch (err) {
        task.reject(err);
      }
    }

    this.isProcessingQueue = false;
  }

  private async executeTranscription(
    wavBuffer: ArrayBuffer,
    language = 'en',
    signal?: AbortSignal
  ): Promise<string> {
    const modelPath = this.resolveModelPath(this.activeModelId) || this.resolveModelPath('ggml-tiny.en');

    if (!modelPath) {
      return '[Local Whisper STT: Model not installed. Download speech model in Settings -> Local Hardware & Models]';
    }

    const whisperBinary = this.findWhisperExecutable();
    if (!whisperBinary) {
      return '[Local Whisper STT: Whisper runtime binary not found on system. Place whisper-cli in resources/whisper]';
    }

    // Create an isolated, owner-only temporary directory tagged with this process PID.
    // Transcript output is streamed strictly via stdout (no -otxt file is ever requested),
    // and every file in tempDir is zero-wiped and unlinked on success, error, abort, or exit.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${WHISPER_TEMP_DIR_PREFIX}p${process.pid}-`));
    if (process.platform !== 'win32') {
      try { fs.chmodSync(tempDir, 0o700); } catch {}
    }
    this.activeTempDirs.add(tempDir);
    this.registerExitCleanupHook();

    const tempAudioPath = path.join(tempDir, `${crypto.randomBytes(8).toString('hex')}.wav`);
    const wavBytes = Buffer.from(new Uint8Array(wavBuffer));
    try {
      fs.writeFileSync(tempAudioPath, wavBytes, { mode: 0o600 });
      if (process.platform !== 'win32') {
        try { fs.chmodSync(tempAudioPath, 0o600); } catch {}
      }
    } catch (writeErr) {
      this.secureRemoveTempDir(tempDir);
      throw writeErr;
    } finally {
      wavBytes.fill(0);
    }

    return new Promise<string>((resolve, reject) => {
      let isAborted = false;
      let settled = false;
      const cleanupTemp = () => {
        this.secureRemoveTempDir(tempDir);
      };

      const binaryDir = path.dirname(whisperBinary);
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          whisperBinary,
          buildWhisperCliArgs(modelPath, tempAudioPath, language),
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              LD_LIBRARY_PATH: binaryDir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''),
              DYLD_LIBRARY_PATH: binaryDir + (process.env.DYLD_LIBRARY_PATH ? ':' + process.env.DYLD_LIBRARY_PATH : ''),
            },
          }
        );
      } catch (spawnErr) {
        cleanupTemp();
        console.warn('[WhisperRuntime] Failed to spawn whisper-cli:', spawnErr);
        return resolve('');
      }

      const abortHandler = () => {
        isAborted = true;
        try { child.kill('SIGKILL'); } catch {}
        cleanupTemp();
        if (!settled) {
          settled = true;
          reject(new Error('Transcription cancelled'));
        }
      };

      signal?.addEventListener('abort', abortHandler);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', data => {
        stdout += data.toString();
      });

      child.stderr?.on('data', data => {
        stderr += data.toString();
      });

      child.on('close', code => {
        signal?.removeEventListener('abort', abortHandler);
        cleanupTemp();

        if (isAborted || settled) return;
        settled = true;

        if (code !== 0) {
          console.warn('[WhisperRuntime] Exit code:', code, stderr);
          return resolve('');
        }

        // Clean any residual timestamps or timing metadata from stdout
        const cleaned = stdout
          .replace(/\[\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d\]/g, '')
          .replace(/whisper_print_timings:[\s\S]*$/, '')
          .trim();

        resolve(cleaned);
      });

      child.on('error', err => {
        signal?.removeEventListener('abort', abortHandler);
        cleanupTemp();
        if (isAborted || settled) return;
        settled = true;
        console.warn('[WhisperRuntime] Failed to spawn whisper-cli:', err);
        resolve('');
      });
    });
  }

  public findWhisperExecutable(): string | null {
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'whisper-cli.exe' : 'whisper-cli';

    // 1. Explicit environment variable
    if (process.env.WHISPER_CLI_PATH && fs.existsSync(process.env.WHISPER_CLI_PATH)) {
      return process.env.WHISPER_CLI_PATH;
    }

    // 2. Electron packaged resourcesPath (production distribution)
    if ((process as any).resourcesPath) {
      const prodPath = path.join((process as any).resourcesPath, 'whisper', binaryName);
      if (fs.existsSync(prodPath)) return prodPath;
    }

    // 3. Development / app resources directory
    const candidates = [
      path.join(process.cwd(), 'resources', 'whisper', binaryName),
      path.join(process.cwd(), 'app', 'resources', 'whisper', binaryName),
      path.join(__dirname, '..', '..', 'resources', 'whisper', binaryName),
      path.join(this.modelsDir, binaryName),
      path.join(os.homedir(), '.scandium', 'bin', binaryName),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    return null;
  }
}

export const whisperRuntime = new WhisperRuntime();
