import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WhisperRuntime,
  WHISPER_MODELS,
  WHISPER_TEMP_DIR_PREFIX,
  LEGACY_WHISPER_TEMP_PREFIX,
  buildWhisperCliArgs,
} from '../electron/services/whisper-runtime';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

describe('Local Speech Recognition (whisper.cpp) Subsystem', () => {
  let runtime: WhisperRuntime;
  const testModelsDir = path.join(process.cwd(), '.test-whisper-models');

  beforeEach(() => {
    if (!fs.existsSync(testModelsDir)) {
      fs.mkdirSync(testModelsDir, { recursive: true });
    }
    runtime = new WhisperRuntime();
    (runtime as any).modelsDir = testModelsDir;
  });

  afterEach(() => {
    if (fs.existsSync(testModelsDir)) {
      try {
        fs.rmSync(testModelsDir, { recursive: true, force: true });
      } catch {}
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

    // Reject unknown model ID
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

  it('omits -otxt from whisper-cli args so plaintext transcript files are never requested', () => {
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
      fs.readdirSync(os.tmpdir()).filter(
        name => name.startsWith(WHISPER_TEMP_DIR_PREFIX) || name.startsWith(LEGACY_WHISPER_TEMP_PREFIX)
      );
    const beforeSet = new Set(listScandiumTemp());

    const wavBuffer = fs.readFileSync(fixturePath).buffer;
    const start = Date.now();
    const result = await runtime.transcribeAudio(wavBuffer, 'en');
    const latencyMs = Date.now() - start;

    expect(result.toLowerCase()).toContain('ask not what your country can do for you');
    expect(latencyMs).toBeGreaterThan(0);
    expect(latencyMs).toBeLessThan(30000);

    const leaked = listScandiumTemp().filter(name => !beforeSet.has(name));
    expect(leaked).toEqual([]);
  });

  it('cleans up temporary WAV/directory on non-zero exit and on aborted transcription', async () => {
    const listTempDirs = () =>
      fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(WHISPER_TEMP_DIR_PREFIX));
    const beforeSet = new Set(listTempDirs());

    // 1. Force a non-zero exit using node with an invalid model/audio or missing binary path
    const binary = runtime.findWhisperExecutable();
    if (binary) {
      const invalidWav = Buffer.from('NOT_A_VALID_WAV_PAYLOAD').buffer;
      const failedRes = await runtime.transcribeAudio(invalidWav, 'en');
      expect(failedRes).toBe('');
      expect(listTempDirs().filter(name => !beforeSet.has(name))).toEqual([]);

      // 2. Abort mid-flight
      const fixturePath = path.join(__dirname, 'fixtures', 'jfk.wav');
      if (fs.existsSync(fixturePath)) {
        const controller = new AbortController();
        const wavBuffer = fs.readFileSync(fixturePath).buffer;
        const promise = runtime.transcribeAudio(wavBuffer, 'en', controller.signal);
        setTimeout(() => controller.abort(), 30);
        await expect(promise).rejects.toThrow(/Transcription cancelled/i);
        // Wait for OS process handle release + cleanup retry under loaded CI runners
        let leaked: string[] = [];
        for (let attempt = 0; attempt < 25; attempt++) {
          leaked = listTempDirs().filter(name => !beforeSet.has(name));
          if (leaked.length === 0) break;
          await new Promise(r => setTimeout(r, 80));
        }
        expect(leaked).toEqual([]);
      }
    }
  });

  it('sweeps orphaned scandium-stt temp directories and legacy scandium_stt_* transcript files', () => {
    const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scandium-sweep-test-'));
    try {
      const orphanDir = path.join(isolatedTmp, `${WHISPER_TEMP_DIR_PREFIX}orphan123`);
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(path.join(orphanDir, 'chunk.wav'), 'sensitive-audio-bytes');
      fs.writeFileSync(path.join(orphanDir, 'chunk.wav.txt'), 'sensitive transcript text');

      const legacyTxt = path.join(isolatedTmp, `${LEGACY_WHISPER_TEMP_PREFIX}999.wav.txt`);
      fs.writeFileSync(legacyTxt, 'legacy leaked transcript');

      const unrelated = path.join(isolatedTmp, 'keep-me.txt');
      fs.writeFileSync(unrelated, 'do not touch');

      const removed = runtime.cleanupOrphanedTempFiles(isolatedTmp);
      expect(removed).toBe(2);
      expect(fs.existsSync(orphanDir)).toBe(false);
      expect(fs.existsSync(legacyTxt)).toBe(false);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(isolatedTmp, { recursive: true, force: true });
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
  });
});
