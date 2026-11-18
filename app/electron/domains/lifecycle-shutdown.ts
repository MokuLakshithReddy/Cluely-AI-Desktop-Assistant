import { app } from 'electron';
import type { WhisperCleanupReport } from '../services/whisper-runtime';
import { realtimeSTTManager as defaultRealtimeSTT } from '../services/realtime-stt-manager';
import { whisperRuntime as defaultWhisper } from '../services/whisper-runtime';
import { stateManager as defaultStateManager } from './state';

export type ShutdownPhase = 'idle' | 'shutting_down' | 'clean' | 'failed';

export interface ShutdownResult {
  success: boolean;
  cleanShutdown: boolean;
  realtimeStopped: boolean;
  whisperClean: boolean;
  activeProcessesRemaining: boolean;
  failedPaths: Array<{ path: string; error: string }>;
  errors: string[];
  durationMs: number;
}

export interface RealtimeSTTLifecycle {
  shutdown: () => Promise<void>;
  hasActiveProcess: () => boolean;
  stop?: () => Promise<void>;
}

export interface WhisperLifecycle {
  shutdown: (baseTmpDir?: string) => Promise<WhisperCleanupReport>;
  hasActiveProcesses?: () => boolean;
}

export interface StateManagerLifecycle {
  flushSave: () => void;
  patchState: (patch: Record<string, any>) => void;
}

export interface LifecycleShutdownOptions {
  realtimeSTT?: RealtimeSTTLifecycle;
  whisper?: WhisperLifecycle;
  stateManager?: StateManagerLifecycle;
  writeSmokeStatus?: (patch: Record<string, unknown>) => void;
  exitApp?: () => void;
  onShutdownFailure?: (result: ShutdownResult) => void;
}

/**
 * Coordinates application shutdown across Electron lifecycle events, state persistence,
 * and audio child-process termination (RealtimeSTT and WhisperRuntime).
 *
 * Guarantees:
 * 1. Single-flight mutex prevents duplicate concurrent shutdown runs.
 * 2. Never reports clean shutdown or permits normal exit if an audio child process remains active
 *    or if sensitive temporary audio files could not be removed.
 * 3. Provides actionable error state on failure and enables controlled retry/recovery.
 * 4. Prevents repeated before-quit loops and deadlocks.
 */
export class LifecycleShutdownCoordinator {
  private phase: ShutdownPhase = 'idle';
  private inFlightPromise: Promise<ShutdownResult> | null = null;
  private lastResult: ShutdownResult | null = null;
  private attemptCount = 0;
  private isClean = false;

  private readonly realtimeSTT: RealtimeSTTLifecycle;
  private readonly whisper: WhisperLifecycle;
  private readonly stateManager: StateManagerLifecycle;
  private readonly writeSmokeStatus?: (patch: Record<string, unknown>) => void;
  private readonly exitApp: () => void;
  private readonly onShutdownFailure?: (result: ShutdownResult) => void;

  constructor(options?: LifecycleShutdownOptions) {
    this.realtimeSTT = options?.realtimeSTT ?? defaultRealtimeSTT;
    this.whisper = options?.whisper ?? defaultWhisper;
    this.stateManager = options?.stateManager ?? defaultStateManager;
    this.writeSmokeStatus = options?.writeSmokeStatus;
    this.exitApp = options?.exitApp ?? (() => {
      try {
        if (typeof app !== 'undefined' && typeof app.quit === 'function') {
          app.quit();
        }
      } catch (err) {
        console.error('[LifecycleShutdown] Failed to invoke app.quit():', err);
      }
    });
    this.onShutdownFailure = options?.onShutdownFailure;
  }

  public getPhase(): ShutdownPhase {
    return this.phase;
  }

  public isShuttingDown(): boolean {
    return this.phase === 'shutting_down';
  }

  public isCleanShutdown(): boolean {
    return this.isClean;
  }

  public hasFailed(): boolean {
    return this.phase === 'failed';
  }

  public getLastResult(): ShutdownResult | null {
    return this.lastResult;
  }

  public getAttemptCount(): number {
    return this.attemptCount;
  }

  /**
   * Primary entry point to request application shutdown.
   * Serialized via single-flight mutex: concurrent calls share the active promise
   * to prevent duplicate kill signals or race conditions.
   */
  public async requestShutdown(options?: { force?: boolean }): Promise<ShutdownResult> {
    if (this.isClean && this.lastResult) {
      return this.lastResult;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    const run = this.executeShutdown(options);
    this.inFlightPromise = run;
    try {
      return await run;
    } finally {
      if (this.inFlightPromise === run) {
        this.inFlightPromise = null;
      }
    }
  }

  /**
   * Allows retrying shutdown after a prior failure.
   */
  public async retryShutdown(options?: { force?: boolean }): Promise<ShutdownResult> {
    if (this.phase === 'failed') {
      this.phase = 'idle';
    }
    return this.requestShutdown(options);
  }

  private async executeShutdown(options?: { force?: boolean }): Promise<ShutdownResult> {
    const startTime = Date.now();
    this.phase = 'shutting_down';
    this.attemptCount++;
    console.log(
      `[LifecycleShutdown] Initiating application shutdown sequence (attempt #${this.attemptCount}, force=${Boolean(options?.force)})...`
    );

    // 1. Flush application state to disk before tearing down processes
    try {
      this.stateManager.flushSave();
    } catch (saveErr) {
      console.warn('[LifecycleShutdown] Warning: Failed to flush state to disk during shutdown:', saveErr);
    }

    // 2. Shut down RealtimeSTT sidecar
    let realtimeError: string | null = null;
    let realtimeStopped = false;
    try {
      await this.realtimeSTT.shutdown();
      realtimeStopped = !this.realtimeSTT.hasActiveProcess();
      if (!realtimeStopped) {
        realtimeError = 'RealtimeSTT sidecar child process remains active';
      }
    } catch (err: any) {
      realtimeError = err?.message || String(err);
      realtimeStopped = !this.realtimeSTT.hasActiveProcess();
    }

    // 3. Shut down WhisperRuntime & verify temporary-file cleanup
    let whisperReport: WhisperCleanupReport | null = null;
    let whisperError: string | null = null;
    let whisperClean = false;
    try {
      whisperReport = await this.whisper.shutdown();
      const hasActiveWhisper = Boolean(
        this.whisper.hasActiveProcesses && this.whisper.hasActiveProcesses()
      );
      whisperClean = Boolean(
        whisperReport &&
        whisperReport.success === true &&
        whisperReport.failedPaths.length === 0 &&
        !hasActiveWhisper
      );
      if (!whisperClean && !whisperError) {
        if (hasActiveWhisper) {
          whisperError = 'Whisper child process(es) remain active in process tree';
        } else if (whisperReport && whisperReport.failedPaths.length > 0) {
          whisperError = `Failed to remove temporary Whisper files: ${whisperReport.failedPaths.map(p => `${p.path} (${p.error})`).join('; ')}`;
        } else {
          whisperError = 'Whisper cleanup reported unconfirmed failure';
        }
      }
    } catch (err: any) {
      whisperError = err?.message || String(err);
      whisperClean = false;
    }

    // 4. Verify overall process tree and cleanup integrity
    const activeProcessesRemaining =
      this.realtimeSTT.hasActiveProcess() ||
      Boolean(this.whisper.hasActiveProcesses && this.whisper.hasActiveProcesses());

    const errors: string[] = [];
    if (realtimeError) errors.push(`RealtimeSTT: ${realtimeError}`);
    if (whisperError) errors.push(`Whisper: ${whisperError}`);
    if (activeProcessesRemaining && errors.length === 0) {
      errors.push('Audio sidecar or worker process remains active in process tree');
    }

    const failedPaths = whisperReport?.failedPaths ? [...whisperReport.failedPaths] : [];
    const isClean = realtimeStopped && whisperClean && !activeProcessesRemaining && errors.length === 0;
    const durationMs = Date.now() - startTime;

    if (isClean) {
      this.phase = 'clean';
      this.isClean = true;
      this.lastResult = {
        success: true,
        cleanShutdown: true,
        realtimeStopped: true,
        whisperClean: true,
        activeProcessesRemaining: false,
        failedPaths: [],
        errors: [],
        durationMs,
      };
      this.writeSmokeStatus?.({ cleanShutdown: true });
      console.log(`[LifecycleShutdown] Application shutdown confirmed clean in ${durationMs}ms.`);
      this.exitApp();
      return this.lastResult;
    }

    // Handle failure: fail closed, do not mark clean, do not exit
    this.phase = 'failed';
    this.isClean = false;
    this.lastResult = {
      success: false,
      cleanShutdown: false,
      realtimeStopped,
      whisperClean,
      activeProcessesRemaining,
      failedPaths,
      errors,
      durationMs,
    };
    const errorSummary = errors.join('; ');
    console.error(`[LifecycleShutdown] Application shutdown failed closed after ${durationMs}ms:`, errorSummary);

    this.writeSmokeStatus?.({
      cleanShutdown: false,
      shutdownFailed: true,
      errors,
    });

    this.stateManager.patchState({
      persistenceError: `Shutdown blocked: ${errorSummary}. Audio process or temporary files remain active. Please retry shutdown or force exit.`,
    });
    try {
      this.stateManager.flushSave();
    } catch {}

    this.onShutdownFailure?.(this.lastResult);
    return this.lastResult;
  }

  /**
   * Electron 'before-quit' event handler.
   * If shutdown is confirmed clean, allows Electron to exit normally.
   * Otherwise prevents premature synchronous quit and coordinates async shutdown.
   */
  public handleBeforeQuit(event: { preventDefault: () => void }): void {
    if (this.isClean) {
      // Clean shutdown confirmed. Let Electron quit without interruption.
      return;
    }

    // Intercept quit synchronously so async cleanup can execute
    event.preventDefault();

    if (this.phase === 'shutting_down') {
      // Already running; do not initiate duplicate shutdown
      return;
    }

    void this.requestShutdown();
  }

  /**
   * Electron 'will-quit' event handler.
   */
  public handleWillQuit(event?: { preventDefault: () => void }): void {
    if (!this.isClean) {
      console.warn('[LifecycleShutdown] Warning: will-quit invoked while shutdown was not confirmed clean.');
    }
  }

  /**
   * Resets coordinator state (primarily for test isolation).
   */
  public resetForTesting(): void {
    this.phase = 'idle';
    this.inFlightPromise = null;
    this.lastResult = null;
    this.attemptCount = 0;
    this.isClean = false;
  }
}

export const lifecycleShutdownCoordinator = new LifecycleShutdownCoordinator();
