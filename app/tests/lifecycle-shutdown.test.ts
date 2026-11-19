import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LifecycleShutdownCoordinator,
  type RealtimeSTTLifecycle,
  type WhisperLifecycle,
  type StateManagerLifecycle,
} from '../electron/domains/lifecycle-shutdown';
import type { WhisperCleanupReport } from '../electron/services/whisper-runtime';

describe('Lifecycle Shutdown Coordinator & Application Lifecycle Guarantees', () => {
  let mockRealtime: {
    shutdown: ReturnType<typeof vi.fn>;
    hasActiveProcess: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };

  let mockWhisper: {
    shutdown: ReturnType<typeof vi.fn>;
    hasActiveProcesses: ReturnType<typeof vi.fn>;
  };

  let mockState: {
    flushSave: ReturnType<typeof vi.fn>;
    patchState: ReturnType<typeof vi.fn>;
  };

  let mockWriteSmokeStatus: ReturnType<typeof vi.fn>;
  let mockExitApp: ReturnType<typeof vi.fn>;
  let mockOnShutdownFailure: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRealtime = {
      shutdown: vi.fn().mockResolvedValue(undefined),
      hasActiveProcess: vi.fn().mockReturnValue(false),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    mockWhisper = {
      shutdown: vi.fn().mockResolvedValue({
        removedCount: 2,
        failedPaths: [],
        success: true,
      } as WhisperCleanupReport),
      hasActiveProcesses: vi.fn().mockReturnValue(false),
    };

    mockState = {
      flushSave: vi.fn(),
      patchState: vi.fn(),
    };

    mockWriteSmokeStatus = vi.fn();
    mockExitApp = vi.fn();
    mockOnShutdownFailure = vi.fn();
  });

  function createCoordinator(overrides?: {
    realtime?: Partial<RealtimeSTTLifecycle>;
    whisper?: Partial<WhisperLifecycle>;
    state?: Partial<StateManagerLifecycle>;
  }) {
    return new LifecycleShutdownCoordinator({
      realtimeSTT: { ...mockRealtime, ...overrides?.realtime },
      whisper: { ...mockWhisper, ...overrides?.whisper },
      stateManager: { ...mockState, ...overrides?.state },
      writeSmokeStatus: mockWriteSmokeStatus,
      exitApp: mockExitApp,
      onShutdownFailure: mockOnShutdownFailure,
    });
  }

  it('guarantees clean application shutdown when RealtimeSTT and Whisper terminate gracefully', async () => {
    const coordinator = createCoordinator();

    const result = await coordinator.requestShutdown();

    expect(result.success).toBe(true);
    expect(result.cleanShutdown).toBe(true);
    expect(result.realtimeStopped).toBe(true);
    expect(result.whisperClean).toBe(true);
    expect(result.activeProcessesRemaining).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.failedPaths).toEqual([]);

    expect(mockState.flushSave).toHaveBeenCalledTimes(1);
    expect(mockRealtime.shutdown).toHaveBeenCalledTimes(1);
    expect(mockWhisper.shutdown).toHaveBeenCalledTimes(1);
    expect(mockWriteSmokeStatus).toHaveBeenCalledWith({ cleanShutdown: true });
    expect(mockExitApp).toHaveBeenCalledTimes(1);
    expect(mockOnShutdownFailure).not.toHaveBeenCalled();

    expect(coordinator.isCleanShutdown()).toBe(true);
    expect(coordinator.getPhase()).toBe('clean');

    // On subsequent before-quit, clean exit is permitted without calling preventDefault()
    const quitEvent = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(quitEvent);
    expect(quitEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('confirms clean shutdown after forced termination followed by verified child exit', async () => {
    let sidecarRunning = true;
    mockRealtime.shutdown = vi.fn().mockImplementation(async () => {
      // Simulates forced escalation terminating the sidecar process
      sidecarRunning = false;
    });
    mockRealtime.hasActiveProcess = vi.fn().mockImplementation(() => sidecarRunning);

    const coordinator = createCoordinator();

    const result = await coordinator.requestShutdown({ force: true });

    expect(result.success).toBe(true);
    expect(result.cleanShutdown).toBe(true);
    expect(result.realtimeStopped).toBe(true);
    expect(result.whisperClean).toBe(true);
    expect(result.activeProcessesRemaining).toBe(false);
    expect(mockExitApp).toHaveBeenCalledTimes(1);
    expect(coordinator.isCleanShutdown()).toBe(true);
  });

  it('fails closed when RealtimeSTT sidecar termination rejects or times out', async () => {
    mockRealtime.shutdown = vi.fn().mockRejectedValue(
      new Error('[RealtimeSTT] Sidecar did not confirm termination within 7000ms deadline')
    );
    mockRealtime.hasActiveProcess = vi.fn().mockReturnValue(true);

    const coordinator = createCoordinator();

    const result = await coordinator.requestShutdown();

    expect(result.success).toBe(false);
    expect(result.cleanShutdown).toBe(false);
    expect(result.realtimeStopped).toBe(false);
    expect(result.activeProcessesRemaining).toBe(true);
    expect(result.errors.some(e => e.includes('RealtimeSTT') && e.includes('deadline'))).toBe(true);

    // Must NOT call app.quit() or exit on failure!
    expect(mockExitApp).not.toHaveBeenCalled();
    expect(mockWriteSmokeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ cleanShutdown: false, shutdownFailed: true })
    );

    // Actionable error state persisted to stateManager
    expect(mockState.patchState).toHaveBeenCalledWith(
      expect.objectContaining({
        persistenceError: expect.stringContaining('Shutdown blocked: RealtimeSTT'),
      })
    );
    expect(mockOnShutdownFailure).toHaveBeenCalledWith(result);
    expect(coordinator.isCleanShutdown()).toBe(false);
    expect(coordinator.hasFailed()).toBe(true);

    // On before-quit, must prevent exit
    const quitEvent = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(quitEvent);
    expect(quitEvent.preventDefault).toHaveBeenCalled();
  });

  it('fails closed and records actionable error when Whisper temporary cleanup fails', async () => {
    const failedLockedDir = 'C:\\Users\\test\\AppData\\Local\\Temp\\scandium-stt-p100-locked';
    mockWhisper.shutdown = vi.fn().mockResolvedValue({
      removedCount: 1,
      failedPaths: [{ path: failedLockedDir, error: 'EBUSY: resource locked by another process' }],
      success: false,
    });

    const coordinator = createCoordinator();

    const result = await coordinator.requestShutdown();

    expect(result.success).toBe(false);
    expect(result.cleanShutdown).toBe(false);
    expect(result.whisperClean).toBe(false);
    expect(result.failedPaths).toEqual([
      { path: failedLockedDir, error: 'EBUSY: resource locked by another process' },
    ]);
    expect(result.errors.some(e => e.includes('Whisper') && e.includes('EBUSY'))).toBe(true);

    expect(mockExitApp).not.toHaveBeenCalled();
    expect(mockState.patchState).toHaveBeenCalledWith(
      expect.objectContaining({
        persistenceError: expect.stringContaining('Shutdown blocked: Whisper: Failed to remove temporary Whisper files'),
      })
    );
    expect(coordinator.isCleanShutdown()).toBe(false);
  });

  it('fails closed when either RealtimeSTT or Whisper process remains active in process tree', async () => {
    // Case A: RealtimeSTT reports active process even though shutdown did not throw
    mockRealtime.shutdown = vi.fn().mockResolvedValue(undefined);
    mockRealtime.hasActiveProcess = vi.fn().mockReturnValue(true);

    const coordinatorA = createCoordinator();
    const resultA = await coordinatorA.requestShutdown();

    expect(resultA.success).toBe(false);
    expect(resultA.cleanShutdown).toBe(false);
    expect(resultA.activeProcessesRemaining).toBe(true);
    expect(resultA.realtimeStopped).toBe(false);
    expect(mockExitApp).not.toHaveBeenCalled();

    // Case B: Whisper reports active child process even though report returned success
    mockRealtime.hasActiveProcess = vi.fn().mockReturnValue(false);
    mockWhisper.hasActiveProcesses = vi.fn().mockReturnValue(true);

    const coordinatorB = createCoordinator();
    const resultB = await coordinatorB.requestShutdown();

    expect(resultB.success).toBe(false);
    expect(resultB.cleanShutdown).toBe(false);
    expect(resultB.activeProcessesRemaining).toBe(true);
    expect(resultB.whisperClean).toBe(false);
    expect(mockExitApp).not.toHaveBeenCalled();
  });

  it('prevents duplicate concurrent shutdown operations via single-flight mutex', async () => {
    let resolveSTT: () => void;
    mockRealtime.shutdown = vi.fn().mockImplementation(
      () => new Promise<void>(resolve => { resolveSTT = resolve; })
    );

    const coordinator = createCoordinator();

    // Trigger 5 concurrent shutdown calls
    const promise1 = coordinator.requestShutdown();
    const promise2 = coordinator.requestShutdown();
    const promise3 = coordinator.requestShutdown();
    const promise4 = coordinator.requestShutdown();
    const promise5 = coordinator.requestShutdown();

    expect(coordinator.isShuttingDown()).toBe(true);
    expect(mockRealtime.shutdown).toHaveBeenCalledTimes(1);

    // Resolve in-flight sidecar shutdown
    resolveSTT!();

    const [res1, res2, res3, res4, res5] = await Promise.all([
      promise1,
      promise2,
      promise3,
      promise4,
      promise5,
    ]);

    expect(res1.success).toBe(true);
    expect(res2).toBe(res1);
    expect(res3).toBe(res1);
    expect(res4).toBe(res1);
    expect(res5).toBe(res1);

    // Critical: underlying services called strictly ONCE
    expect(mockRealtime.shutdown).toHaveBeenCalledTimes(1);
    expect(mockWhisper.shutdown).toHaveBeenCalledTimes(1);
    expect(mockExitApp).toHaveBeenCalledTimes(1);
    expect(coordinator.getAttemptCount()).toBe(1);
  });

  it('provides a controlled retry mechanism that recovers from a prior transient failure', async () => {
    // Attempt 1: Whisper temp directory locked
    mockWhisper.shutdown.mockResolvedValueOnce({
      removedCount: 0,
      failedPaths: [{ path: '/tmp/locked-dir', error: 'EPERM: operation not permitted' }],
      success: false,
    });

    const coordinator = createCoordinator();

    const result1 = await coordinator.requestShutdown();
    expect(result1.success).toBe(false);
    expect(coordinator.hasFailed()).toBe(true);
    expect(mockExitApp).not.toHaveBeenCalled();

    // Attempt 2: Lock released; Whisper cleanup succeeds
    mockWhisper.shutdown.mockResolvedValueOnce({
      removedCount: 1,
      failedPaths: [],
      success: true,
    });

    const result2 = await coordinator.retryShutdown();
    expect(result2.success).toBe(true);
    expect(result2.cleanShutdown).toBe(true);
    expect(coordinator.isCleanShutdown()).toBe(true);
    expect(mockExitApp).toHaveBeenCalledTimes(1);
    expect(coordinator.getAttemptCount()).toBe(2);
  });

  it('prevents before-quit infinite loops and deadlocks', async () => {
    const coordinator = createCoordinator();

    const firstEvent = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(firstEvent);

    // Initial before-quit was intercepted to permit async shutdown
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(coordinator.isShuttingDown()).toBe(true);

    // Calling before-quit while shutdown is in flight does not spawn duplicate runs
    const duplicateEvent = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(duplicateEvent);
    expect(duplicateEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(coordinator.getAttemptCount()).toBe(1);

    // Await completion of in-flight shutdown
    await coordinator.requestShutdown();

    expect(coordinator.isCleanShutdown()).toBe(true);
    expect(mockExitApp).toHaveBeenCalledTimes(1);

    // Second before-quit (triggered by app.quit() after clean shutdown):
    // Must NOT call preventDefault(), allowing Electron to exit cleanly
    const finalEvent = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
  });
});
