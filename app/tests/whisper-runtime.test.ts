import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  WhisperRuntime,
  WHISPER_MODELS,
  WHISPER_TEMP_DIR_PREFIX,
  LEGACY_WHISPER_TEMP_PREFIX,
  buildWhisperCliArgs,
  whisperRuntime,
} from '../electron/services/whisper-runtime';
import { ipcMain } from 'electron';
import { IpcRouter } from '../electron/domains/ipc-router';
import { stateManager } from '../electron/domains/state';
import { credentialVault } from '../electron/services/vault';
import { sessionRepository } from '../electron/services/session-repository';
import { realtimeSTTManager } from '../electron/services/realtime-stt-manager';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

function createFakeChild(options: {
  closeDelayAfterKillMs?: number;
  autoCloseAfterMs?: number;
  exitCode?: number;
  stdoutText?: string;
  neverExitOnKill?: boolean;
  killThrows?: Error;
  killReturnsFalse?: boolean;
  pid?: number;
} = {}) {
  const child = new EventEmitter() as any;
  child.pid = options.pid ?? 65432;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.killCalls = [] as Array<string | undefined>;

  const emitClose = (code: number | null, signal: string | null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };

  child.forceCloseNow = (code: number | null = null, signal: string | null = 'SIGKILL') => {
    emitClose(code, signal);
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
    if (options.neverExitOnKill) {
      return true;
    }
    const delay = options.closeDelayAfterKillMs ?? 0;
    if (delay > 0) {
      setTimeout(() => emitClose(null, sig || 'SIGKILL'), delay);
    } else {
      setImmediate(() => emitClose(null, sig || 'SIGKILL'));
    }
    return true;
  });

  if (options.autoCloseAfterMs !== undefined) {
    setTimeout(() => {
      if (options.stdoutText) {
        child.stdout.emit('data', Buffer.from(options.stdoutText));
      }
      emitClose(options.exitCode ?? 0, null);
    }, options.autoCloseAfterMs);
  }

  return child;
}

describe('Local Speech Recognition (whisper.cpp) Subsystem', () => {
  let runtime: WhisperRuntime;
  let isolatedTmp: string;
  const testModelsDir = path.join(process.cwd(), '.test-whisper-models');

  beforeEach(() => {
    if (!fs.existsSync(testModelsDir)) {
      fs.mkdirSync(testModelsDir, { recursive: true });
    }
    isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scandium-whisper-suite-'));
    runtime = new WhisperRuntime({ baseTmpDir: isolatedTmp, retryDelayMs: 15, maxCleanupRetries: 4 });
    (runtime as any).modelsDir = testModelsDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of [testModelsDir, isolatedTmp]) {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('provides verified registry of open-weight GGML Whisper models with exact SHA-256 hashes', () => {
    const tiny = WHISPER_MODELS['ggml-tiny.en'];
    expect(tiny).toBeDefined();
    expect(tiny.filename).toBe('ggml-tiny.en.bin');
    expect(tiny.sizeBytes).toBe(77704715);
    expect(tiny.url.startsWith('https://huggingface.co/')).toBe(true);
    expect(tiny.sha256).toBe('921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f');

    const base = WHISPER_MODELS['ggml-base.en'];
    expect(base).toBeDefined();
    expect(base.filename).toBe('ggml-base.en.bin');
    expect(base.sizeBytes).toBe(147964211);
    expect(base.sha256).toBe('a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002');
  });

  it('tracks active model selection safely', () => {
    expect(runtime.getActiveModelId()).toBe('ggml-tiny.en');

    runtime.setActiveModel('ggml-base.en');
    expect(runtime.getActiveModelId()).toBe('ggml-base.en');

    runtime.setActiveModel('unknown-model');
    expect(runtime.getActiveModelId()).toBe('ggml-base.en');
  });

  it('accurately computes SHA-256 file checksums via streaming digest', async () => {
    const testFile = path.join(testModelsDir, 'checksum-test.txt');
    const content = 'scandium-whisper-test-payload-12345';
    fs.writeFileSync(testFile, content);

    const expectedDigest = crypto.createHash('sha256').update(content).digest('hex');
    const digest = await runtime.computeFileSha256(testFile);
    expect(digest).toBe(expectedDigest);
  });

  it('returns clean diagnostic message when attempting transcription with uninstalled model', async () => {
    runtime.setActiveModel('ggml-base.en');
    vi.spyOn(runtime, 'resolveModelPath').mockReturnValue(null);

    const dummyWav = new ArrayBuffer(1024);
    const result = await runtime.transcribeAudio(dummyWav);
    expect(result).toContain('Local Whisper STT: Model not installed');
  });

  it('returns clean diagnostic message when model exists but whisper binary is missing', async () => {
    vi.spyOn(runtime, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(runtime, 'findWhisperExecutable').mockReturnValue(null);

    const dummyWav = new ArrayBuffer(1024);
    const result = await runtime.transcribeAudio(dummyWav);
    expect(result).toContain('Whisper runtime binary not found');
  });

  it('omits -otxt and --output-txt from whisper-cli args so plaintext transcript files are never requested', () => {
    const args = buildWhisperCliArgs('/models/tiny.en.bin', '/tmp/scandium-stt-x/input.wav', 'en');
    expect(args).not.toContain('-otxt');
    expect(args).not.toContain('--output-txt');
    expect(args).toContain('-nt');
    expect(args).toContain('-np');
    expect(args).toContain('/tmp/scandium-stt-x/input.wav');
  });

  it('launches native whisper-cli, transcribes known audio sample, and leaves zero WAV or TXT files in temp storage', async () => {
    const binary = runtime.findWhisperExecutable();
    const fixturePath = path.join(__dirname, 'fixtures', 'jfk.wav');
    if (!binary || !fs.existsSync(fixturePath)) {
      return;
    }

    const listScandiumTemp = () =>
      fs.readdirSync(isolatedTmp).filter(
        name => name.startsWith(WHISPER_TEMP_DIR_PREFIX) || name.startsWith(LEGACY_WHISPER_TEMP_PREFIX)
      );

    const wavBuffer = fs.readFileSync(fixturePath).buffer;
    const start = Date.now();
    const result = await runtime.transcribeAudio(wavBuffer, 'en');
    const latencyMs = Date.now() - start;

    expect(result.toLowerCase()).toContain('ask not what your country can do for you');
    expect(latencyMs).toBeGreaterThan(0);
    expect(latencyMs).toBeLessThan(30000);
    expect(listScandiumTemp()).toEqual([]);
  });

  it('cleans up temporary WAV/directory synchronously before settling on non-zero exit and on aborted transcription', async () => {
    const listTempDirs = () =>
      fs.readdirSync(isolatedTmp).filter(name => name.startsWith(WHISPER_TEMP_DIR_PREFIX));

    const binary = runtime.findWhisperExecutable();
    if (binary) {
      const invalidWav = Buffer.from('NOT_A_VALID_WAV_PAYLOAD').buffer;
      const failedRes = await runtime.transcribeAudio(invalidWav, 'en');
      expect(failedRes).toBe('');
      expect(listTempDirs()).toEqual([]);

      const fixturePath = path.join(__dirname, 'fixtures', 'jfk.wav');
      if (fs.existsSync(fixturePath)) {
        const controller = new AbortController();
        const wavBuffer = fs.readFileSync(fixturePath).buffer;
        const promise = runtime.transcribeAudio(wavBuffer, 'en', controller.signal);
        setTimeout(() => controller.abort(), 30);
        await expect(promise).rejects.toThrow(/Transcription cancelled/i);
        // No polling: temp directory MUST already be deleted at the exact instant rejection settles.
        expect(listTempDirs()).toEqual([]);
      }
    }
  });

  it('waits for delayed child-process close event and temp cleanup before rejecting cancelled transcription', async () => {
    let spawnedAudioPath = '';
    let childClosed = false;
    const fakeChild = createFakeChild({ closeDelayAfterKillMs: 120 });
    fakeChild.once('close', () => {
      childClosed = true;
    });

    const rt = new WhisperRuntime({
      baseTmpDir: isolatedTmp,
      retryDelayMs: 10,
      maxCleanupRetries: 4,
      spawnFn: ((_bin: string, args: string[]) => {
        spawnedAudioPath = args[args.indexOf('-f') + 1];
        return fakeChild;
      }) as any,
    });
    vi.spyOn(rt, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(rt, 'findWhisperExecutable').mockReturnValue('/mock/whisper-cli');

    const controller = new AbortController();
    const promise = rt.transcribeAudio(new ArrayBuffer(256), 'en', controller.signal);

    // Wait briefly until child is spawned and temp WAV exists on disk
    await new Promise(r => setTimeout(r, 20));
    expect(spawnedAudioPath).toBeTruthy();
    expect(fs.existsSync(spawnedAudioPath)).toBe(true);

    controller.abort();
    await expect(promise).rejects.toThrow(/Transcription cancelled/i);

    // Assert synchronously at settlement — no polling!
    expect(childClosed).toBe(true);
    expect(fs.existsSync(spawnedAudioPath)).toBe(false);
    expect(fs.existsSync(path.dirname(spawnedAudioPath))).toBe(false);
    expect(rt.getActiveTempDirs()).toEqual([]);
  });

  it('recovers from Windows-style EBUSY file locks via bounded retries during temp cleanup', async () => {
    let unlinkAttempts = 0;
    const fakeChild = createFakeChild({ autoCloseAfterMs: 15, exitCode: 0, stdoutText: 'Hello locked Windows file' });

    const rt = new WhisperRuntime({
      baseTmpDir: isolatedTmp,
      retryDelayMs: 15,
      maxCleanupRetries: 5,
      spawnFn: (() => fakeChild) as any,
      unlinkFileFn: (filePath: string) => {
        unlinkAttempts++;
        if (unlinkAttempts <= 2) {
          const err: any = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        fs.unlinkSync(filePath);
      },
    });
    vi.spyOn(rt, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(rt, 'findWhisperExecutable').mockReturnValue('/mock/whisper-cli');

    const text = await rt.transcribeAudio(new ArrayBuffer(128), 'en');
    expect(text).toBe('Hello locked Windows file');
    expect(unlinkAttempts).toBe(3);
    expect(fs.readdirSync(isolatedTmp)).toEqual([]);
  });

  it('explicitly reports failure instead of silently claiming success when temp deletion permanently fails', async () => {
    const fakeChild = createFakeChild({ autoCloseAfterMs: 10, exitCode: 0, stdoutText: 'Transcript' });

    const rt = new WhisperRuntime({
      baseTmpDir: isolatedTmp,
      retryDelayMs: 5,
      maxCleanupRetries: 2,
      spawnFn: (() => fakeChild) as any,
      unlinkFileFn: () => {
        const err: any = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      },
    });
    vi.spyOn(rt, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(rt, 'findWhisperExecutable').mockReturnValue('/mock/whisper-cli');

    await expect(rt.transcribeAudio(new ArrayBuffer(128), 'en')).rejects.toThrow(/cleanup failed/i);

    const report = await rt.abortAllAndCleanup(isolatedTmp);
    expect(report.success).toBe(false);
    expect(report.failedPaths.length).toBeGreaterThan(0);
    expect(report.failedPaths[0].error).toContain('EACCES');
  });

  it('terminates active transcription and deletes temp files on application shutdown, rejecting new jobs', async () => {
    let spawnedAudioPath = '';
    const fakeChild = createFakeChild({ closeDelayAfterKillMs: 60 });

    const rt = new WhisperRuntime({
      baseTmpDir: isolatedTmp,
      retryDelayMs: 10,
      maxCleanupRetries: 4,
      spawnFn: ((_bin: string, args: string[]) => {
        spawnedAudioPath = args[args.indexOf('-f') + 1];
        return fakeChild;
      }) as any,
    });
    vi.spyOn(rt, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(rt, 'findWhisperExecutable').mockReturnValue('/mock/whisper-cli');

    const activePromise = rt.transcribeAudio(new ArrayBuffer(256), 'en');
    const activeCheck = expect(activePromise).rejects.toThrow(/Transcription cancelled/i);
    await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(spawnedAudioPath)).toBe(true);

    const shutdownReport = await rt.shutdown(isolatedTmp);
    expect(shutdownReport.success).toBe(true);
    expect(fs.existsSync(spawnedAudioPath)).toBe(false);
    expect(fs.readdirSync(isolatedTmp)).toEqual([]);

    await activeCheck;
    await expect(rt.transcribeAudio(new ArrayBuffer(64), 'en')).rejects.toThrow(/shutting down/i);
  });

  it('fails closed on Whisper child termination timeout without deleting WAV while child is still alive', async () => {
    let spawnedAudioPath = '';
    const hungChild = createFakeChild({ neverExitOnKill: true });

    const rt = new WhisperRuntime({
      baseTmpDir: isolatedTmp,
      retryDelayMs: 10,
      maxCleanupRetries: 2,
      childExitTimeoutMs: 60,
      spawnFn: ((_bin: string, args: string[]) => {
        spawnedAudioPath = args[args.indexOf('-f') + 1];
        return hungChild;
      }) as any,
    });
    vi.spyOn(rt, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(rt, 'findWhisperExecutable').mockReturnValue('/mock/whisper-cli');

    const controller = new AbortController();
    const activePromise = rt.transcribeAudio(new ArrayBuffer(256), 'en', controller.signal);
    const activeCheck = expect(activePromise).rejects.toThrow(/did not terminate within 60ms deadline/i);

    await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(spawnedAudioPath)).toBe(true);

    controller.abort();
    await activeCheck;

    // Temp WAV MUST NOT be deleted while the unresponsive child might still be accessing it
    expect(fs.existsSync(spawnedAudioPath)).toBe(true);
    expect(rt.getActiveTempDirs()).toContain(path.dirname(spawnedAudioPath));

    // abortAllAndCleanup must also fail closed while the child refuses to exit
    const failReport = await rt.abortAllAndCleanup(isolatedTmp);
    expect(failReport.success).toBe(false);
    expect(failReport.failedPaths.length).toBeGreaterThan(0);
    expect(failReport.failedPaths[0].error).toMatch(/did not terminate/i);
    expect(fs.existsSync(spawnedAudioPath)).toBe(true);

    // Once the child actually exits, recovery cleanup deletes the temp WAV cleanly
    hungChild.forceCloseNow(null, 'SIGKILL');
    const recoveryReport = await rt.abortAllAndCleanup(isolatedTmp);
    expect(recoveryReport.success).toBe(true);
    expect(fs.existsSync(spawnedAudioPath)).toBe(false);
  });

  it('fails closed on Whisper kill failure (EPERM / rejected kill) without deleting WAV under live process', async () => {
    let spawnedAudioPath = '';
    const epermErr: any = new Error('EPERM: cannot signal whisper-cli');
    epermErr.code = 'EPERM';
    const protectedChild = createFakeChild({ killThrows: epermErr });

    const rt = new WhisperRuntime({
      baseTmpDir: isolatedTmp,
      retryDelayMs: 10,
      maxCleanupRetries: 2,
      childExitTimeoutMs: 60,
      spawnFn: ((_bin: string, args: string[]) => {
        spawnedAudioPath = args[args.indexOf('-f') + 1];
        return protectedChild;
      }) as any,
    });
    vi.spyOn(rt, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(rt, 'findWhisperExecutable').mockReturnValue('/mock/whisper-cli');

    const controller = new AbortController();
    const activePromise = rt.transcribeAudio(new ArrayBuffer(256), 'en', controller.signal);
    const activeCheck = expect(activePromise).rejects.toThrow(/Failed to kill whisper-cli.*EPERM/i);

    await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(spawnedAudioPath)).toBe(true);

    controller.abort();
    await activeCheck;

    // Must not delete temp WAV while child termination failed
    expect(fs.existsSync(spawnedAudioPath)).toBe(true);

    const report = await rt.abortAllAndCleanup(isolatedTmp);
    expect(report.success).toBe(false);
    expect(report.failedPaths[0].error).toMatch(/EPERM/i);
    expect(fs.existsSync(spawnedAudioPath)).toBe(true);

    // Also test direct terminateChildAndWait when kill() returns false for a live PID
    const falseKillChild = createFakeChild({ killReturnsFalse: true, pid: process.pid });
    const termRes = await rt.terminateChildAndWait(falseKillChild);
    expect(termRes.exited).toBe(false);
    expect(termRes.error).toMatch(/rejected by OS/i);
  });

  it('sweeps orphaned scandium-stt temp directories and legacy scandium_stt_* files while preserving other live processes', async () => {
    const orphanDir = path.join(isolatedTmp, `${WHISPER_TEMP_DIR_PREFIX}p999999-orphan`);
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'chunk.wav'), 'sensitive-audio-bytes');
    fs.writeFileSync(path.join(orphanDir, 'chunk.wav.txt'), 'sensitive transcript text');

    const legacyTxt = path.join(isolatedTmp, `${LEGACY_WHISPER_TEMP_PREFIX}999.wav.txt`);
    fs.writeFileSync(legacyTxt, 'legacy leaked transcript');

    const unrelated = path.join(isolatedTmp, 'keep-me.txt');
    fs.writeFileSync(unrelated, 'do not touch');

    // Simulate another live process PID (parent process PID, if different from current PID)
    const otherLivePid = process.ppid && process.ppid !== process.pid ? process.ppid : null;
    const otherLiveDir = otherLivePid
      ? path.join(isolatedTmp, `${WHISPER_TEMP_DIR_PREFIX}p${otherLivePid}-live`)
      : null;
    if (otherLiveDir) {
      fs.mkdirSync(otherLiveDir, { recursive: true });
      fs.writeFileSync(path.join(otherLiveDir, 'active.wav'), 'live-other-process');
    }

    const report = await runtime.cleanupOrphanedTempFilesAsync(isolatedTmp);
    expect(report.success).toBe(true);
    expect(report.removedCount).toBe(2);
    expect(fs.existsSync(orphanDir)).toBe(false);
    expect(fs.existsSync(legacyTxt)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    if (otherLiveDir) {
      expect(fs.existsSync(otherLiveDir)).toBe(true);
    }

    // Repeated purge is idempotent
    const secondReport = await runtime.abortAllAndCleanup(isolatedTmp);
    expect(secondReport.success).toBe(true);
    expect(secondReport.removedCount).toBe(0);
  });

  it('handles multiple simultaneous transcription jobs and repeated purge safely', async () => {
    const children: any[] = [];
    const rt = new WhisperRuntime({
      baseTmpDir: isolatedTmp,
      retryDelayMs: 10,
      maxCleanupRetries: 4,
      spawnFn: (() => {
        const c = createFakeChild({ closeDelayAfterKillMs: 40 });
        children.push(c);
        return c;
      }) as any,
    });
    vi.spyOn(rt, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(rt, 'findWhisperExecutable').mockReturnValue('/mock/whisper-cli');

    const job1 = rt.transcribeAudio(new ArrayBuffer(128), 'en');
    const job2 = rt.transcribeAudio(new ArrayBuffer(128), 'en');
    const job3 = rt.transcribeAudio(new ArrayBuffer(128), 'en');
    const job1Check = expect(job1).rejects.toThrow(/Transcription cancelled/i);
    const job2Check = expect(job2).rejects.toThrow(/Transcription cancelled/i);
    const job3Check = expect(job3).rejects.toThrow(/Transcription cancelled/i);

    await new Promise(r => setTimeout(r, 20));
    const [purge1, purge2] = await Promise.all([
      rt.abortAllAndCleanup(isolatedTmp),
      rt.abortAllAndCleanup(isolatedTmp),
    ]);

    expect(purge1.success).toBe(true);
    expect(purge2.success).toBe(true);
    expect(fs.readdirSync(isolatedTmp)).toEqual([]);

    await Promise.all([job1Check, job2Check, job3Check]);
  });

  it('PROVES purge-all-data does NOT resolve while an active transcription temp file still exists on disk', async () => {
    let activeTempAudioPath = '';
    let activeTempDir = '';
    let childClosed = false;
    let unlinkRetryCount = 0;

    const fakeChild = createFakeChild({ closeDelayAfterKillMs: 120 });
    fakeChild.once('close', () => {
      childClosed = true;
    });

    // Patch singleton whisperRuntime hooks cleanly for this test and restore in finally
    const origSpawn = (whisperRuntime as any).spawnFn;
    const origUnlink = (whisperRuntime as any).unlinkFileFn;
    const origBaseTmp = (whisperRuntime as any).baseTmpDirOverride;
    const origRetryDelay = (whisperRuntime as any).retryDelayMs;

    (whisperRuntime as any).spawnFn = (_bin: string, args: string[]) => {
      activeTempAudioPath = args[args.indexOf('-f') + 1];
      activeTempDir = path.dirname(activeTempAudioPath);
      return fakeChild;
    };
    (whisperRuntime as any).unlinkFileFn = (filePath: string) => {
      unlinkRetryCount++;
      if (unlinkRetryCount === 1) {
        const err: any = new Error('EBUSY: simulated Windows handle hold');
        err.code = 'EBUSY';
        throw err;
      }
      fs.unlinkSync(filePath);
    };
    (whisperRuntime as any).baseTmpDirOverride = isolatedTmp;
    (whisperRuntime as any).retryDelayMs = 25;

    const handlers = new Map<string, (...args: any[]) => any>();
    vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, listener: any) => {
      handlers.set(channel, listener);
    }) as any);
    vi.spyOn(ipcMain, 'on').mockImplementation((() => ipcMain) as any);
    vi.spyOn(whisperRuntime, 'resolveModelPath').mockReturnValue(path.join(testModelsDir, 'mock.bin'));
    vi.spyOn(whisperRuntime, 'findWhisperExecutable').mockReturnValue('/mock/whisper-cli');
    vi.spyOn(credentialVault, 'deleteAllKeys').mockResolvedValue(undefined);
    vi.spyOn(sessionRepository, 'purgeAll').mockResolvedValue(undefined);
    vi.spyOn(stateManager, 'flushSaveOrThrow').mockImplementation(() => {});

    try {
      const router = new IpcRouter();
      (router as any).registerHandlers();
      const purgeHandler = handlers.get('purge-all-data');
      expect(purgeHandler).toBeDefined();

      // Start an active transcription directly on whisperRuntime
      const activeTranscription = whisperRuntime.transcribeAudio(new ArrayBuffer(256), 'en');
      const activeTranscriptionCheck = expect(activeTranscription).rejects.toThrow(/Transcription cancelled/i);
      await new Promise(r => setTimeout(r, 25));

      expect(activeTempAudioPath).toBeTruthy();
      expect(fs.existsSync(activeTempAudioPath)).toBe(true);

      // Invoke purge-all-data while child is active & will hold file open + hit 1 EBUSY retry
      let purgeResolvedWhileFileExisted = false;
      const trustedEvent = { senderFrame: { url: 'http://localhost:5173/#dashboard' } };
      const purgeResult = await purgeHandler!(trustedEvent);

      // CRITICAL ASSERTION AT THE EXACT MOMENT PURGE RESOLVES (NO POLLING):
      if (fs.existsSync(activeTempAudioPath) || fs.existsSync(activeTempDir)) {
        purgeResolvedWhileFileExisted = true;
      }

      expect(purgeResult).toBe(true);
      expect(purgeResolvedWhileFileExisted).toBe(false);
      expect(childClosed).toBe(true);
      expect(unlinkRetryCount).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(activeTempAudioPath)).toBe(false);
      expect(fs.existsSync(activeTempDir)).toBe(false);

      await activeTranscriptionCheck;
    } finally {
      (whisperRuntime as any).spawnFn = origSpawn;
      (whisperRuntime as any).unlinkFileFn = origUnlink;
      (whisperRuntime as any).baseTmpDirOverride = origBaseTmp;
      (whisperRuntime as any).retryDelayMs = origRetryDelay;
      stateManager.patchState({ isPurging: false });
    }
  });

  it('gracefully serializes concurrent overlapping audio streams without crashing or process starvation', async () => {
    const binary = runtime.findWhisperExecutable();
    const fixturePath = path.join(__dirname, 'fixtures', 'jfk.wav');
    if (!binary || !fs.existsSync(fixturePath)) {
      return;
    }

    const wavBuffer1 = fs.readFileSync(fixturePath).buffer;
    const wavBuffer2 = fs.readFileSync(fixturePath).buffer;

    const start = Date.now();
    const [res1, res2] = await Promise.all([
      runtime.transcribeAudio(wavBuffer1, 'en'),
      runtime.transcribeAudio(wavBuffer2, 'en'),
    ]);
    const totalDurationMs = Date.now() - start;

    expect(res1.toLowerCase()).toContain('ask not what your country can do for you');
    expect(res2.toLowerCase()).toContain('ask not what your country can do for you');
    expect(totalDurationMs).toBeGreaterThan(0);
    expect(fs.readdirSync(isolatedTmp)).toEqual([]);
  });

  it('fails closed in IPC purge-all-data when whisperRuntime reports active processes remain', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, listener: any) => {
      handlers.set(channel, listener);
    }) as any);
    vi.spyOn(ipcMain, 'on').mockImplementation((() => ipcMain) as any);
    vi.spyOn(realtimeSTTManager, 'stop').mockResolvedValue(undefined);
    vi.spyOn(realtimeSTTManager, 'hasActiveProcess').mockReturnValue(false);
    vi.spyOn(whisperRuntime, 'abortAllAndCleanup').mockResolvedValue({
      removedCount: 1,
      failedPaths: [],
      success: true,
    });
    vi.spyOn(whisperRuntime, 'hasActiveProcesses').mockReturnValue(true);
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
        /Data purge incomplete: failed to remove temporary Whisper files or child processes remain/i
      );

      expect(deleteKeysSpy).not.toHaveBeenCalled();
      expect(purgeSessionsSpy).not.toHaveBeenCalled();
    } finally {
      stateManager.patchState({ isPurging: false });
      vi.restoreAllMocks();
    }
  });
});
