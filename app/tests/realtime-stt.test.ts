import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { ipcMain } from 'electron';
import { RealtimeSTTManager, realtimeSTTManager } from '../electron/services/realtime-stt-manager';
import { IpcRouter } from '../electron/domains/ipc-router';
import { stateManager } from '../electron/domains/state';
import { credentialVault } from '../electron/services/vault';
import { sessionRepository } from '../electron/services/session-repository';
import { whisperRuntime } from '../electron/services/whisper-runtime';
import { AudioResampler } from '../src/lib/vad';

function createFakeSidecarChild(options: {
  exitOnShutdownCommandMs?: number;
  exitOnSigkillMs?: number;
  killThrows?: Error;
  killReturnsFalse?: boolean;
  pid?: number;
} = {}) {
  const child = new EventEmitter() as any;
  child.pid = options.pid ?? 54321;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.writtenCommands = [] as string[];
  child.killCalls = [] as Array<string | undefined>;

  const emitTerminated = (code: number | null, signal: string | null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };

  child.forceExitNow = (code: number | null = 0, signal: string | null = null) => {
    emitTerminated(code, signal);
  };

  child.stdin = {
    destroyed: false,
    writable: true,
    write: vi.fn((chunk: string) => {
      child.writtenCommands.push(chunk);
      if (chunk.includes('"shutdown"') && options.exitOnShutdownCommandMs !== undefined) {
        setTimeout(() => emitTerminated(0, null), options.exitOnShutdownCommandMs);
      }
      return true;
    }),
  };

  child.kill = vi.fn((sig?: string) => {
    child.killCalls.push(sig);
    if (options.killThrows) {
      throw options.killThrows;
    }
    if (options.killReturnsFalse) {
      return false;
    }
    child.killed = true;
    if (options.exitOnSigkillMs !== undefined) {
      setTimeout(() => emitTerminated(null, sig || 'SIGKILL'), options.exitOnSigkillMs);
    }
    return true;
  });

  return child;
}

describe('RealtimeSTT Local Speech-to-Text Subsystem ($0 Cost Local STT)', () => {
  let manager: RealtimeSTTManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    manager = new RealtimeSTTManager();
  });

  it('correctly converts Float32 audio samples into 16-bit signed PCM little-endian buffer', () => {
    const input = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    expect(buffer.byteLength).toBe(10);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBeCloseTo(16383, -1);
    expect(view.getInt16(4, true)).toBeCloseTo(-16384, -1);
    expect(view.getInt16(6, true)).toBe(32767);
    expect(view.getInt16(8, true)).toBe(-32768);
  });

  it('correctly downsamples 48kHz audio to 16kHz for Whisper inference', () => {
    const resampler = new AudioResampler(48000, 16000);
    const input48k = new Float32Array(4800); // 100ms at 48kHz
    for (let i = 0; i < input48k.length; i++) {
      input48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    }

    const output16k = resampler.resample(input48k);
    expect(output16k.length).toBe(1600); // exactly 100ms at 16kHz
    expect(output16k[0]).toBeCloseTo(input48k[0], 2);
  });

  it('initializes in synthetic mode and reports status accurately', async () => {
    const started = await manager.start('tiny.en');
    expect(started).toBe(true);

    const status = manager.getStatus();
    expect(status.status).toBe('ready');
    expect(status.model).toBe('tiny.en');
    expect(status.modelsDir).toContain('realtime-models');
  });

  it('supports model profile switching between tiny.en, base.en, and small.en', async () => {
    await manager.start('tiny.en');
    expect(manager.getStatus().model).toBe('tiny.en');

    await manager.start('base.en');
    expect(manager.getStatus().model).toBe('base.en');

    await manager.start('small.en');
    expect(manager.getStatus().model).toBe('small.en');
  });

  it('allows subscription to interim, final, and status event listeners', async () => {
    let interimCalled = false;
    let finalCalled = false;
    let statusCalled = false;

    const unInterim = manager.onInterim((text) => {
      interimCalled = true;
      expect(text).toBe('hello');
    });

    const unFinal = manager.onFinal((text) => {
      finalCalled = true;
      expect(text).toBe('hello world');
    });

    const unStatus = manager.onStatus((status) => {
      statusCalled = true;
      expect(status).toBe('ready');
    });

    await manager.start('tiny.en');
    expect(statusCalled).toBe(true);

    unInterim();
    unFinal();
    unStatus();
  });

  it('gracefully handles feedAudioChunk and feedSilence without throwing', () => {
    expect(() => {
      manager.feedAudioChunk(Buffer.alloc(3200));
      manager.feedAudioChunk('AAAA');
      manager.feedSilence(0.5);
    }).not.toThrow();
  });

  it('shuts down cleanly and transitions status to stopped', async () => {
    await manager.start('tiny.en');
    await manager.stop();
    expect(manager.getStatus().status).toBe('stopped');
  });

  it('pauses and resumes transcription state', async () => {
    await manager.start('tiny.en');
    manager.pause();
    expect(manager.getStatus().status).toBe('paused');
    manager.resume();
    expect(manager.getStatus().status).toBe('ready');
    await manager.stop();
  });

  it('processes raw PCM audio from jfk.wav fixture and converts to valid 16-bit little-endian chunks', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const jfkPath = path.join(__dirname, 'fixtures', 'jfk.wav');
    if (fs.existsSync(jfkPath)) {
      const wavBuffer = fs.readFileSync(jfkPath);
      // WAV header is 44 bytes; remaining is 16-bit PCM at 16kHz
      const pcmData = wavBuffer.subarray(44);
      expect(pcmData.byteLength % 2).toBe(0);

      await manager.start('tiny.en');
      // Feed first 100ms (3200 bytes = 1600 samples)
      const chunk = pcmData.subarray(0, 3200);
      expect(() => manager.feedAudioChunk(chunk)).not.toThrow();
      await manager.stop();
    }
  });

  it('handles model-switch requests without improper coalescing', async () => {
    await manager.start('tiny.en');
    expect(manager.getStatus().model).toBe('tiny.en');

    // Switch to base.en
    const switched = await manager.start('base.en');
    expect(switched).toBe(true);
    expect(manager.getStatus().model).toBe('base.en');
    await manager.stop();
  });

  it('allows subscription to stabilized event listener', async () => {
    let stabilizedCalled = false;
    const unStabilized = manager.onStabilized((text, ts) => {
      stabilizedCalled = true;
      expect(text).toBe('my fellow Americans');
      expect(ts).toBeGreaterThan(0);
    });

    expect(typeof unStabilized).toBe('function');
    unStabilized();
  });

  it('returns model cache info and handles model deletion gracefully', async () => {
    await manager.start('tiny.en');
    const info = await manager.getModelsInfo();
    expect(Array.isArray(info)).toBe(true);

    const deleteActive = await manager.deleteModel('tiny.en');
    expect(deleteActive.success).toBe(false); // cannot delete active model
    expect(deleteActive.message).toContain('actively in use');

    const deleteMissing = await manager.deleteModel('non-existent-model');
    expect(deleteMissing.success).toBe(false);
    expect(deleteMissing.message).toContain('not found');

    await manager.shutdown();
    expect(manager.getStatus().status).toBe('stopped');
  });

  it('rejects path traversal and parent-directory payloads in deleteModel without touching parent folders', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scandium-rtstt-sec-'));
    const modelsDir = path.join(sandboxRoot, 'realtime-models');
    const siblingDir = path.join(sandboxRoot, 'sessions');
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    const sentinel = path.join(siblingDir, 'keep.json');
    fs.writeFileSync(sentinel, 'protected');

    try {
      (manager as any).modelsDir = modelsDir;

      for (const maliciousId of ['..', '.', '../sessions', '..\\sessions', 'foo/bar', 'foo\\bar', '']) {
        const res = await manager.deleteModel(maliciousId);
        expect(res.success).toBe(false);
      }

      expect(fs.existsSync(modelsDir)).toBe(true);
      expect(fs.existsSync(siblingDir)).toBe(true);
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it('confirms graceful shutdown only after sidecar exits cleanly without forcing SIGKILL', async () => {
    const rt = new RealtimeSTTManager({
      gracefulStopTimeoutMs: 120,
      forceStopTimeoutMs: 120,
      syntheticTestMode: false,
    });
    const fakeChild = createFakeSidecarChild({ exitOnShutdownCommandMs: 25 });
    (rt as any).child = fakeChild;
    (rt as any).status = 'ready';

    await rt.stop();

    expect(fakeChild.writtenCommands.some((c: string) => c.includes('"type":"shutdown"'))).toBe(true);
    expect(fakeChild.killCalls).toEqual([]);
    expect(rt.getChildProcess()).toBeNull();
    expect(rt.hasActiveProcess()).toBe(false);
    expect(rt.getStatus().status).toBe('stopped');
  });

  it('escalates to SIGKILL when graceful shutdown times out and resolves only after actual exit', async () => {
    const rt = new RealtimeSTTManager({
      gracefulStopTimeoutMs: 40,
      forceStopTimeoutMs: 200,
      syntheticTestMode: false,
    });
    const fakeChild = createFakeSidecarChild({ exitOnSigkillMs: 35 });
    (rt as any).child = fakeChild;
    (rt as any).status = 'ready';

    await rt.stop();

    expect(fakeChild.writtenCommands.some((c: string) => c.includes('"type":"shutdown"'))).toBe(true);
    expect(fakeChild.killCalls).toEqual(['SIGKILL']);
    expect(fakeChild.signalCode).toBe('SIGKILL');
    expect(rt.getChildProcess()).toBeNull();
    expect(rt.hasActiveProcess()).toBe(false);
    expect(rt.getStatus().status).toBe('stopped');
  });

  it('rejects and preserves child reference when sidecar never exits within the bounded deadline, enabling later recovery', async () => {
    const rt = new RealtimeSTTManager({
      gracefulStopTimeoutMs: 30,
      forceStopTimeoutMs: 40,
      syntheticTestMode: false,
    });
    const unresponsiveChild = createFakeSidecarChild({});
    (rt as any).child = unresponsiveChild;
    (rt as any).status = 'ready';

    await expect(rt.stop()).rejects.toThrow(/did not confirm termination/i);

    // Process reference MUST be preserved for recovery/retry
    expect(rt.getChildProcess()).toBe(unresponsiveChild);
    expect(rt.hasActiveProcess()).toBe(true);
    expect(rt.getStatus().status).toBe('error');

    // Now simulate recovery: child responds to SIGKILL on retry
    unresponsiveChild.kill = vi.fn((sig?: string) => {
      setTimeout(() => unresponsiveChild.forceExitNow(null, sig || 'SIGKILL'), 15);
      return true;
    });

    await rt.shutdown();
    expect(rt.getChildProcess()).toBeNull();
    expect(rt.hasActiveProcess()).toBe(false);
    expect(rt.getStatus().status).toBe('stopped');
  });

  it('rejects explicitly and preserves child reference when SIGKILL throws or is rejected by OS', async () => {
    const rt1 = new RealtimeSTTManager({
      gracefulStopTimeoutMs: 20,
      forceStopTimeoutMs: 50,
      syntheticTestMode: false,
    });
    const epermErr: any = new Error('EPERM: operation not permitted');
    epermErr.code = 'EPERM';
    const childThrow = createFakeSidecarChild({ killThrows: epermErr });
    (rt1 as any).child = childThrow;
    (rt1 as any).status = 'ready';

    await expect(rt1.stop()).rejects.toThrow(/Forced SIGKILL failed.*EPERM/i);
    expect(rt1.getChildProcess()).toBe(childThrow);
    expect(rt1.hasActiveProcess()).toBe(true);
    expect(rt1.getStatus().status).toBe('error');

    const rt2 = new RealtimeSTTManager({
      gracefulStopTimeoutMs: 20,
      forceStopTimeoutMs: 50,
      syntheticTestMode: false,
    });
    const childFalse = createFakeSidecarChild({ killReturnsFalse: true, pid: process.pid });
    (rt2 as any).child = childFalse;
    (rt2 as any).status = 'ready';

    await expect(rt2.stop()).rejects.toThrow(/Forced SIGKILL was rejected/i);
    expect(rt2.getChildProcess()).toBe(childFalse);
    expect(rt2.getStatus().status).toBe('error');
  });

  it('fails closed in IPC purge-all-data when RealtimeSTT sidecar termination fails', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, listener: any) => {
      handlers.set(channel, listener);
    }) as any);
    vi.spyOn(ipcMain, 'on').mockImplementation((() => ipcMain) as any);
    vi.spyOn(realtimeSTTManager, 'stop').mockRejectedValue(
      new Error('[RealtimeSTT] Sidecar did not confirm termination within 3000ms deadline')
    );
    vi.spyOn(whisperRuntime, 'abortAllAndCleanup').mockResolvedValue({
      removedCount: 0,
      failedPaths: [],
      success: true,
    });
    const deleteKeysSpy = vi.spyOn(credentialVault, 'deleteAllKeys').mockResolvedValue(undefined);
    const purgeSessionsSpy = vi.spyOn(sessionRepository, 'purgeAll').mockResolvedValue(undefined);
    vi.spyOn(stateManager, 'flushSaveOrThrow').mockImplementation(() => {});

    try {
      const router = new IpcRouter();
      (router as any).registerHandlers();
      const purgeHandler = handlers.get('purge-all-data');
      expect(purgeHandler).toBeDefined();

      const trustedEvent = { senderFrame: { url: 'http://localhost:5173/#dashboard' } };
      await expect(purgeHandler!(trustedEvent)).rejects.toThrow(
        /Data purge failed closed: RealtimeSTT sidecar could not be confirmed stopped/i
      );

      // Must not claim purge completed or proceed to mark state clean while sidecar is still running
      expect(deleteKeysSpy).not.toHaveBeenCalled();
      expect(purgeSessionsSpy).not.toHaveBeenCalled();
      expect(stateManager.getState().isPurging).toBe(false);
    } finally {
      stateManager.patchState({ isPurging: false });
      vi.restoreAllMocks();
    }
  });
});
