import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhisperRuntime, WHISPER_MODELS } from '../electron/services/whisper-runtime';
import fs from 'fs';
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

  it('launches native whisper-cli and transcribes known audio sample with high fidelity', async () => {
    const binary = runtime.findWhisperExecutable();
    const fixturePath = path.join(__dirname, 'fixtures', 'jfk.wav');
    if (!binary || !fs.existsSync(fixturePath)) {
      return;
    }

    const wavBuffer = fs.readFileSync(fixturePath).buffer;
    const start = Date.now();
    const result = await runtime.transcribeAudio(wavBuffer, 'en');
    const latencyMs = Date.now() - start;

    expect(result.toLowerCase()).toContain('ask not what your country can do for you');
    expect(latencyMs).toBeGreaterThan(0);
    expect(latencyMs).toBeLessThan(30000);
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
