import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import https from 'https';
import { spawn, ChildProcess } from 'child_process';
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

export interface TempCleanupResult {
  removed: boolean;
  path: string;
  attempts: number;
  error?: string;
}

export interface WhisperCleanupReport {
  removedCount: number;
  failedPaths: Array<{ path: string; error: string }>;
  success: boolean;
}

export interface WhisperRuntimeOptions {
  spawnFn?: typeof spawn;
  unlinkFileFn?: (filePath: string) => void;
  rmDirFn?: (dirPath: string) => void;
  retryDelayMs?: number;
  maxCleanupRetries?: number;
  childExitTimeoutMs?: number;
  baseTmpDir?: string;
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

const MAX_DOWNLOAD_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_OVERWRITE_BYTES = 32 * 1024 * 1024;
const RETRYABLE_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE']);

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function getAppVersionSafe(): string {
  try {
    const v = app?.getVersion?.();
    return typeof v === 'string' && v.trim() ? v.trim() : '1.0.2';
  } catch {
    return '1.0.2';
  }
}

const registeredWhisperRuntimes = new Set<WhisperRuntime>();
let globalExitCleanupHookRegistered = false;

function registerGlobalWhisperExitHook(instance: WhisperRuntime): void {
  registeredWhisperRuntimes.add(instance);
  if (globalExitCleanupHookRegistered) return;
  globalExitCleanupHookRegistered = true;
  process.once('exit', () => {
    for (const rt of Array.from(registeredWhisperRuntimes)) {
      rt.cleanupSyncOnProcessExit();
    }
  });
}

export class WhisperRuntime {
  private modelsDir: string;
  private activeModelId = 'ggml-tiny.en';
  private downloadingModelId: string | null = null;
  private downloadProgress = 0;
  private activeTempDirs = new Set<string>();
  private pendingCleanups = new Map<string, Promise<TempCleanupResult>>();
  private activeChildren = new Set<ChildProcess>();
  private activeChildByTempDir = new Map<string, ChildProcess>();
  private activeExecutions = new Set<Promise<void>>();
  private activeAbortControllers = new Set<AbortController>();
  private isShuttingDown = false;
  private exitHookRegistered = false;
  private readonly spawnFn: typeof spawn;
  private readonly unlinkFileFn: (filePath: string) => void;
  private readonly rmDirFn: (dirPath: string) => void;
  private readonly retryDelayMs: number;
  private readonly maxCleanupRetries: number;
  private readonly childExitTimeoutMs: number;
  private readonly baseTmpDirOverride?: string;
  private transcriptionQueue: Array<{
    wavBuffer: ArrayBuffer;
    language: string;
    signal?: AbortSignal;
    resolve: (text: string) => void;
    reject: (err: any) => void;
  }> = [];
  private isProcessingQueue = false;

  constructor(options: WhisperRuntimeOptions = {}) {
    this.spawnFn = options.spawnFn || spawn;
    this.unlinkFileFn = options.unlinkFileFn || ((p: string) => fs.unlinkSync(p));
    this.rmDirFn = options.rmDirFn || ((p: string) => fs.rmSync(p, { recursive: true, force: false }));
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.maxCleanupRetries = options.maxCleanupRetries ?? 8;
    this.childExitTimeoutMs = options.childExitTimeoutMs ?? 3000;
    this.baseTmpDirOverride = options.baseTmpDir;

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

  private getBaseTmpDir(): string {
    return this.baseTmpDirOverride || os.tmpdir();
  }

  private registerExitCleanupHook(): void {
    if (this.exitHookRegistered) return;
    this.exitHookRegistered = true;
    registerGlobalWhisperExitHook(this);
  }

  /** @internal Synchronous last-resort cleanup on Node process exit. */
  public cleanupSyncOnProcessExit(): void {
    for (const child of Array.from(this.activeChildren)) {
      try { child.kill('SIGKILL'); } catch {}
    }
    for (const dir of Array.from(this.activeTempDirs)) {
      const boundChild = this.activeChildByTempDir.get(dir);
      if (boundChild && boundChild.exitCode === null && boundChild.signalCode === null) {
        continue;
      }
      this.removeTempDirSyncOnce(dir);
    }
  }

  /**
   * Best-effort application-level overwrite and unlink of a single file.
   * Note: Overwriting before unlink is a best-effort application hygiene step and
   * does not guarantee forensic erasure on SSDs, flash storage, or copy-on-write filesystems.
   */
  private bestEffortUnlinkFile(filePath: string): { removed: boolean; error?: string; code?: string } {
    try {
      if (!fs.existsSync(filePath)) return { removed: true };
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_OVERWRITE_BYTES) {
        try {
          fs.writeFileSync(filePath, Buffer.alloc(stat.size), { mode: 0o600 });
        } catch {
          // Proceed to unlink even if overwrite is blocked (e.g., read-only file)
        }
      }
      this.unlinkFileFn(filePath);
      if (fs.existsSync(filePath)) {
        return { removed: false, error: 'File still exists after unlink' };
      }
      return { removed: true };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { removed: true };
      return { removed: false, error: err?.message || String(err), code: err?.code };
    }
  }

  private removeTempDirSyncOnce(tempDir: string): { removed: boolean; error?: string; code?: string } {
    try {
      if (!fs.existsSync(tempDir)) {
        this.activeTempDirs.delete(tempDir);
        return { removed: true };
      }
      const stat = fs.lstatSync(tempDir);
      if (!stat.isDirectory()) {
        const res = this.bestEffortUnlinkFile(tempDir);
        if (res.removed) this.activeTempDirs.delete(tempDir);
        return res;
      }

      const entries = fs.readdirSync(tempDir);
      let firstErr: { error?: string; code?: string } | null = null;
      for (const entry of entries) {
        const fullPath = path.join(tempDir, entry);
        try {
          const entryStat = fs.lstatSync(fullPath);
          if (entryStat.isDirectory()) {
            const nested = this.removeTempDirSyncOnce(fullPath);
            if (!nested.removed && !firstErr) firstErr = nested;
          } else {
            const fileRes = this.bestEffortUnlinkFile(fullPath);
            if (!fileRes.removed && !firstErr) firstErr = fileRes;
          }
        } catch (err: any) {
          if (err?.code !== 'ENOENT' && !firstErr) {
            firstErr = { error: err?.message || String(err), code: err?.code };
          }
        }
      }

      if (firstErr) {
        return { removed: false, error: firstErr.error, code: firstErr.code };
      }

      this.rmDirFn(tempDir);
      if (fs.existsSync(tempDir)) {
        return { removed: false, error: 'Temporary directory still exists after removal attempt' };
      }
      this.activeTempDirs.delete(tempDir);
      return { removed: true };
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        this.activeTempDirs.delete(tempDir);
        return { removed: true };
      }
      return { removed: false, error: err?.message || String(err), code: err?.code };
    }
  }

  /**
   * Idempotent, concurrency-safe asynchronous directory removal with bounded retries
   * for Windows file locking (EBUSY / EPERM) and explicit failure reporting.
   */
  public secureRemoveTempDirAsync(tempDir: string): Promise<TempCleanupResult> {
    const existing = this.pendingCleanups.get(tempDir);
    if (existing) return existing;

    const cleanupPromise = (async (): Promise<TempCleanupResult> => {
      let lastError: string | undefined;
      let attempts = 0;
      const maxAttempts = Math.max(1, this.maxCleanupRetries + 1);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        const result = this.removeTempDirSyncOnce(tempDir);
        if (result.removed) {
          return { removed: true, path: tempDir, attempts };
        }
        lastError = result.error || 'Unknown cleanup error';

        const shouldRetry =
          attempt < maxAttempts &&
          (!result.code || RETRYABLE_FS_CODES.has(result.code));
        if (!shouldRetry) break;

        await sleep(this.retryDelayMs);
      }

      const stillExists = fs.existsSync(tempDir);
      if (!stillExists) {
        this.activeTempDirs.delete(tempDir);
        return { removed: true, path: tempDir, attempts };
      }

      return {
        removed: false,
        path: tempDir,
        attempts,
        error: lastError || 'Temporary directory remains on disk after bounded retries',
      };
    })();

    this.pendingCleanups.set(tempDir, cleanupPromise);
    cleanupPromise.finally(() => {
      if (this.pendingCleanups.get(tempDir) === cleanupPromise) {
        this.pendingCleanups.delete(tempDir);
      }
    });

    return cleanupPromise;
  }

  /**
   * Terminates a spawned whisper-cli child process and waits for confirmed OS exit/close.
   * Never reports `{ exited: true }` merely because a kill signal was sent or a deadline elapsed.
   */
  public terminateChildAndWait(child: ChildProcess): Promise<{ exited: boolean; error?: string }> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ exited: true });
    }

    return new Promise<{ exited: boolean; error?: string }>(resolve => {
      let finished = false;
      let escalateTimer: NodeJS.Timeout | null = null;
      let deadlineTimer: NodeJS.Timeout | null = null;

      const finish = (result: { exited: boolean; error?: string }) => {
        if (finished) return;
        finished = true;
        if (escalateTimer) clearTimeout(escalateTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        child.removeListener('close', onExit);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        resolve(result);
      };

      const onExit = () => {
        finish({ exited: true });
      };

      const onError = (err: any) => {
        // Spawn failure before an OS process ever started (pid undefined) means no process is running.
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
          finish({ exited: true });
          return;
        }
        finish({
          exited: false,
          error: `whisper-cli process error during termination: ${err?.message || String(err)}`,
        });
      };

      const sendSignal = (sig: NodeJS.Signals): boolean => {
        try {
          const accepted = child.kill(sig);
          if (accepted === false) {
            if (child.exitCode !== null || child.signalCode !== null) {
              finish({ exited: true });
              return false;
            }
            if (typeof child.pid === 'number' && !this.isProcessAlive(child.pid)) {
              finish({ exited: true });
              return false;
            }
            finish({
              exited: false,
              error: `Failed to signal whisper-cli (${sig} rejected by OS); process may still be running`,
            });
            return false;
          }
          return true;
        } catch (killErr: any) {
          if (killErr?.code === 'ESRCH' && typeof child.pid === 'number' && !this.isProcessAlive(child.pid)) {
            finish({ exited: true });
            return false;
          }
          finish({
            exited: false,
            error: `Failed to kill whisper-cli (${sig}): ${killErr?.message || String(killErr)}`,
          });
          return false;
        }
      };

      child.once('close', onExit);
      child.once('exit', onExit);
      child.once('error', onError);

      const initialSignal: NodeJS.Signals = process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
      if (!sendSignal(initialSignal)) {
        return;
      }

      if (initialSignal !== 'SIGKILL') {
        const halfTimeout = Math.max(25, Math.floor(this.childExitTimeoutMs / 2));
        escalateTimer = setTimeout(() => {
          if (!finished && child.exitCode === null && child.signalCode === null) {
            sendSignal('SIGKILL');
          }
        }, halfTimeout);
        if (typeof escalateTimer.unref === 'function') escalateTimer.unref();
      }

      deadlineTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          finish({ exited: true });
          return;
        }
        finish({
          exited: false,
          error: `whisper-cli child process did not terminate within ${this.childExitTimeoutMs}ms deadline`,
        });
      }, this.childExitTimeoutMs);
      if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    });
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

  private isOwnedByAnotherLiveProcess(entryName: string): boolean {
    const pidMatch = /^scandium-stt-p(\d+)-/.exec(entryName);
    if (!pidMatch) return false;
    const ownerPid = Number(pidMatch[1]);
    return ownerPid !== process.pid && this.isProcessAlive(ownerPid);
  }

  /**
   * Synchronous best-effort orphan sweep (used at startup).
   * Counts only entries verified removed; never silently claims success on failed deletions.
   */
  public cleanupOrphanedTempFiles(baseTmpDir: string = this.getBaseTmpDir()): number {
    let removed = 0;
    try {
      if (!fs.existsSync(baseTmpDir)) return 0;
      const entries = fs.readdirSync(baseTmpDir);
      for (const entry of entries) {
        const fullPath = path.join(baseTmpDir, entry);
        if (entry.startsWith(WHISPER_TEMP_DIR_PREFIX) && !this.activeTempDirs.has(fullPath)) {
          if (this.isOwnedByAnotherLiveProcess(entry)) continue;
          const res = this.removeTempDirSyncOnce(fullPath);
          if (res.removed) removed++;
        } else if (entry.startsWith(LEGACY_WHISPER_TEMP_PREFIX)) {
          const res = this.bestEffortUnlinkFile(fullPath);
          if (res.removed) removed++;
        }
      }
    } catch {}
    return removed;
  }

  /**
   * Asynchronous orphan sweep with bounded retries and explicit failure reporting.
   * Respects active transcriptions and PID-tagged directories owned by other live processes.
   */
  public async cleanupOrphanedTempFilesAsync(baseTmpDir: string = this.getBaseTmpDir()): Promise<WhisperCleanupReport> {
    let removedCount = 0;
    const failedPaths: Array<{ path: string; error: string }> = [];

    if (!fs.existsSync(baseTmpDir)) {
      return { removedCount: 0, failedPaths: [], success: true };
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(baseTmpDir);
    } catch (err: any) {
      return {
        removedCount: 0,
        failedPaths: [{ path: baseTmpDir, error: err?.message || String(err) }],
        success: false,
      };
    }

    for (const entry of entries) {
      const fullPath = path.join(baseTmpDir, entry);
      if (entry.startsWith(WHISPER_TEMP_DIR_PREFIX) && !this.activeTempDirs.has(fullPath)) {
        if (this.isOwnedByAnotherLiveProcess(entry)) continue;
        const res = await this.secureRemoveTempDirAsync(fullPath);
        if (res.removed) {
          removedCount++;
        } else {
          failedPaths.push({ path: fullPath, error: res.error || 'Failed to remove orphaned temp directory' });
        }
      } else if (entry.startsWith(LEGACY_WHISPER_TEMP_PREFIX)) {
        const res = await this.secureRemoveTempDirAsync(fullPath);
        if (res.removed) {
          removedCount++;
        } else {
          failedPaths.push({ path: fullPath, error: res.error || 'Failed to remove legacy Whisper temp file' });
        }
      }
    }

    return {
      removedCount,
      failedPaths,
      success: failedPaths.length === 0,
    };
  }

  /**
   * Aborts all queued and in-flight transcriptions, waits for child processes to terminate
   * and all active/pending temporary directories to be deleted, then sweeps orphaned files.
   * Does not report success if any owned temporary directory or legacy file remains on disk.
   */
  public async abortAllAndCleanup(baseTmpDir: string = this.getBaseTmpDir()): Promise<WhisperCleanupReport> {
    // 1. Cancel any queued (not yet started) jobs immediately
    while (this.transcriptionQueue.length > 0) {
      const queued = this.transcriptionQueue.shift();
      queued?.reject(new Error('Transcription cancelled'));
    }

    // 2. Abort all active executions
    for (const controller of Array.from(this.activeAbortControllers)) {
      try { controller.abort(); } catch {}
    }

    // 3. Wait for all active executions (which wait for child close + temp cleanup)
    if (this.activeExecutions.size > 0) {
      await Promise.allSettled(Array.from(this.activeExecutions));
    }

    // 4. Wait for any remaining pending cleanup promises
    if (this.pendingCleanups.size > 0) {
      await Promise.allSettled(Array.from(this.pendingCleanups.values()));
    }

    let removedCount = 0;
    const failedPaths: Array<{ path: string; error: string }> = [];
    const seenFailed = new Set<string>();

    // 5. Explicitly verify/retry any activeTempDirs that survived a prior termination or cleanup failure.
    // Never delete a temporary WAV directory while its child process has not been confirmed terminated.
    for (const dir of Array.from(this.activeTempDirs)) {
      const boundChild = this.activeChildByTempDir.get(dir);
      if (boundChild) {
        const termRes = await this.terminateChildAndWait(boundChild);
        if (!termRes.exited) {
          if (!seenFailed.has(dir)) {
            seenFailed.add(dir);
            failedPaths.push({
              path: dir,
              error: termRes.error || 'Whisper child process is still running; refusing to delete active temporary WAV',
            });
          }
          continue;
        }
        this.activeChildren.delete(boundChild);
        this.activeChildByTempDir.delete(dir);
      }

      const res = await this.secureRemoveTempDirAsync(dir);
      if (res.removed) {
        removedCount++;
      } else if (!seenFailed.has(dir)) {
        seenFailed.add(dir);
        failedPaths.push({ path: dir, error: res.error || 'Active temporary directory could not be deleted' });
      }
    }

    // 6. Sweep orphaned own-process / dead-PID dirs and legacy scandium_stt_* files
    const orphanReport = await this.cleanupOrphanedTempFilesAsync(baseTmpDir);
    removedCount += orphanReport.removedCount;
    for (const failure of orphanReport.failedPaths) {
      if (!seenFailed.has(failure.path)) {
        seenFailed.add(failure.path);
        failedPaths.push(failure);
      }
    }

    return {
      removedCount,
      failedPaths,
      success: failedPaths.length === 0,
    };
  }

  /**
   * Application shutdown hook: blocks new transcriptions, terminates active child processes,
   * and awaits temporary-file cleanup before exit.
   */
  public async shutdown(baseTmpDir: string = this.getBaseTmpDir()): Promise<WhisperCleanupReport> {
    this.isShuttingDown = true;
    return this.abortAllAndCleanup(baseTmpDir);
  }

  public getActiveTempDirs(): string[] {
    return Array.from(this.activeTempDirs);
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
      const userAgent = `Scandium-Desktop/${getAppVersionSafe()}`;

      const handleRequest = (currentUrl: string, redirectDepth: number) => {
        if (redirectDepth > MAX_DOWNLOAD_REDIRECTS) {
          file.close();
          return reject(new Error('Model download exceeded maximum redirect limit'));
        }
        let parsed: URL;
        try {
          parsed = new URL(currentUrl);
        } catch {
          file.close();
          return reject(new Error('Invalid model download URL'));
        }
        if (parsed.protocol !== 'https:') {
          file.close();
          return reject(new Error('Model downloads must use HTTPS'));
        }

        const req = https.get(
          {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: { 'User-Agent': userAgent },
            timeout: DOWNLOAD_TIMEOUT_MS,
          },
          res => {
            // Follow redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              res.resume();
              const redirectUrl = new URL(res.headers.location, currentUrl).href;
              return handleRequest(redirectUrl, redirectDepth + 1);
            }

            if (res.statusCode !== 200) {
              res.resume();
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
              file.end(() => resolve());
            });

            res.on('error', err => {
              file.close();
              reject(err);
            });
          }
        );

        req.on('timeout', () => {
          req.destroy();
          file.close();
          reject(new Error('Model download timed out'));
        });

        req.on('error', err => {
          file.close();
          reject(err);
        });
      };

      handleRequest(urlStr, 0);
    });
  }

  public transcribeAudio(
    wavBuffer: ArrayBuffer,
    language = 'en',
    signal?: AbortSignal
  ): Promise<string> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error('Transcription rejected: Whisper runtime is shutting down'));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('Transcription cancelled'));
    }
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

    try {
      while (this.transcriptionQueue.length > 0) {
        const task = this.transcriptionQueue.shift();
        if (!task) break;

        if (this.isShuttingDown || task.signal?.aborted) {
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
    } finally {
      this.isProcessingQueue = false;
      if (this.transcriptionQueue.length > 0 && !this.isShuttingDown) {
        void this.processQueue();
      }
    }
  }

  private async executeTranscription(
    wavBuffer: ArrayBuffer,
    language = 'en',
    signal?: AbortSignal
  ): Promise<string> {
    if (this.isShuttingDown || signal?.aborted) {
      throw new Error('Transcription cancelled');
    }

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
    // and every file in tempDir undergoes best-effort overwrite and removal before settlement.
    const tempDir = fs.mkdtempSync(path.join(this.getBaseTmpDir(), `${WHISPER_TEMP_DIR_PREFIX}p${process.pid}-`));
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
      await this.secureRemoveTempDirAsync(tempDir);
      throw writeErr;
    } finally {
      wavBytes.fill(0);
    }

    const internalController = new AbortController();
    this.activeAbortControllers.add(internalController);
    const forwardAbort = () => internalController.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    let resolveExecution!: () => void;
    const executionPromise = new Promise<void>(resolve => {
      resolveExecution = resolve;
    });
    this.activeExecutions.add(executionPromise);

    const finalizeTracking = () => {
      signal?.removeEventListener('abort', forwardAbort);
      this.activeAbortControllers.delete(internalController);
      this.activeExecutions.delete(executionPromise);
      resolveExecution();
    };

    try {
      if (internalController.signal.aborted || this.isShuttingDown) {
        const cleanupRes = await this.secureRemoveTempDirAsync(tempDir);
        if (!cleanupRes.removed) {
          throw new Error(`Transcription cancelled; temporary file cleanup failed: ${cleanupRes.error}`);
        }
        throw new Error('Transcription cancelled');
      }

      return await new Promise<string>((resolve, reject) => {
        let isAborted = false;
        let settled = false;
        let abortInProgress: Promise<void> | null = null;

        const binaryDir = path.dirname(whisperBinary);
        let child: ChildProcess;
        try {
          child = this.spawnFn(
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
          console.warn('[WhisperRuntime] Failed to spawn whisper-cli:', spawnErr);
          void this.secureRemoveTempDirAsync(tempDir).then(cleanupRes => {
            if (!cleanupRes.removed) {
              console.error('[WhisperRuntime] Failed to clean up temporary directory after spawn error:', cleanupRes);
            }
            if (!settled) {
              settled = true;
              resolve('');
            }
          });
          return;
        }

        this.activeChildren.add(child);
        this.activeChildByTempDir.set(tempDir, child);

        const releaseChildTracking = () => {
          this.activeChildren.delete(child);
          if (this.activeChildByTempDir.get(tempDir) === child) {
            this.activeChildByTempDir.delete(tempDir);
          }
        };

        const settleAfterCleanup = async (outcome: { ok: true; text: string } | { ok: false; err: Error }) => {
          releaseChildTracking();
          internalController.signal.removeEventListener('abort', abortHandler);
          const cleanupRes = await this.secureRemoveTempDirAsync(tempDir);
          if (!cleanupRes.removed) {
            console.error('[WhisperRuntime] Temporary audio cleanup failed:', cleanupRes);
          }
          if (settled) return;
          settled = true;
          if (!cleanupRes.removed) {
            const baseMsg = outcome.ok ? 'Transcription completed but temporary file cleanup failed' : outcome.err.message;
            reject(new Error(`${baseMsg} (${cleanupRes.error})`));
            return;
          }
          if (outcome.ok) {
            resolve(outcome.text);
          } else {
            reject(outcome.err);
          }
        };

        const abortHandler = () => {
          if (abortInProgress) return;
          isAborted = true;
          abortInProgress = (async () => {
            // Wait for confirmed OS child process exit/close BEFORE removing tempDir.
            // If termination cannot be confirmed, do NOT delete the WAV under a live process
            // and preserve both child and tempDir references for fail-closed error reporting / retry.
            const termRes = await this.terminateChildAndWait(child);
            if (!termRes.exited) {
              internalController.signal.removeEventListener('abort', abortHandler);
              // If the unresponsive child exits later, release tracking and remove tempDir then.
              const onLateExit = () => {
                releaseChildTracking();
                void this.secureRemoveTempDirAsync(tempDir);
              };
              child.once('close', onLateExit);
              child.once('exit', onLateExit);
              if (!settled) {
                settled = true;
                reject(
                  new Error(
                    `Transcription cancellation failed: ${termRes.error || 'whisper-cli process did not terminate'}`
                  )
                );
              }
              return;
            }
            await settleAfterCleanup({ ok: false, err: new Error('Transcription cancelled') });
          })();
        };

        internalController.signal.addEventListener('abort', abortHandler, { once: true });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', data => {
          stdout += data.toString();
        });

        child.stderr?.on('data', data => {
          stderr += data.toString();
        });

        child.once('close', code => {
          if (isAborted || abortInProgress) return;

          if (code !== 0) {
            console.warn('[WhisperRuntime] Exit code:', code, stderr);
            void settleAfterCleanup({ ok: true, text: '' });
            return;
          }

          // Clean any residual timestamps or timing metadata from stdout
          const cleaned = stdout
            .replace(/\[\d\d:\d\d:\d\d\.\d\d\d --> \d\d:\d\d:\d\d\.\d\d\d\]/g, '')
            .replace(/whisper_print_timings:[\s\S]*$/, '')
            .trim();

          void settleAfterCleanup({ ok: true, text: cleaned });
        });

        child.once('error', err => {
          if (isAborted || abortInProgress) return;
          console.warn('[WhisperRuntime] Failed to run whisper-cli:', err);
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            abortInProgress = (async () => {
              const termRes = await this.terminateChildAndWait(child);
              if (!termRes.exited) {
                internalController.signal.removeEventListener('abort', abortHandler);
                if (!settled) {
                  settled = true;
                  reject(
                    new Error(
                      `whisper-cli errored and termination could not be confirmed: ${termRes.error || err.message}`
                    )
                  );
                }
                return;
              }
              await settleAfterCleanup({ ok: true, text: '' });
            })();
            return;
          }
          void settleAfterCleanup({ ok: true, text: '' });
        });

        // Handle race if abort fired synchronously right before listener attachment
        if (internalController.signal.aborted) {
          abortHandler();
        }
      });
    } finally {
      finalizeTracking();
    }
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
