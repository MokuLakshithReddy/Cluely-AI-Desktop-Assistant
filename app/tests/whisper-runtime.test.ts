import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WhisperRuntime, WHISPER_MODELS } from '../electron/services/whisper-runtime';
import fs from 'fs';
import path from 'path';

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

  it('provides verified registry of open-weight GGML Whisper models', () => {
    const tiny = WHISPER_MODELS['ggml-tiny.en'];
    expect(tiny).toBeDefined();
    expect(tiny.filename).toBe('ggml-tiny.en.bin');
    expect(tiny.sizeBytes).toBeGreaterThan(70000000);
    expect(tiny.url.startsWith('https://huggingface.co/')).toBe(true);
    expect(tiny.sha256).toBeDefined();

    const base = WHISPER_MODELS['ggml-base.en'];
    expect(base).toBeDefined();
    expect(base.filename).toBe('ggml-base.en.bin');
    expect(base.sizeBytes).toBeGreaterThan(140000000);
  });

  it('tracks active model selection safely', () => {
    expect(runtime.getActiveModelId()).toBe('ggml-tiny.en');

    runtime.setActiveModel('ggml-base.en');
    expect(runtime.getActiveModelId()).toBe('ggml-base.en');

    // Reject unknown model ID
    runtime.setActiveModel('unknown-model');
    expect(runtime.getActiveModelId()).toBe('ggml-base.en');
  });

  it('accurately reports model downloaded state based on file existence and size', () => {
    expect(runtime.isModelDownloaded('ggml-tiny.en')).toBe(false);

    // Create a mock model file > 1MB
    const mockFilePath = path.join(testModelsDir, 'ggml-tiny.en.bin');
    const dummyBuffer = Buffer.alloc(1024 * 1024 + 100);
    fs.writeFileSync(mockFilePath, dummyBuffer);

    expect(runtime.isModelDownloaded('ggml-tiny.en')).toBe(true);

    const models = runtime.getModels();
    const tiny = models.find(m => m.id === 'ggml-tiny.en');
    expect(tiny?.isDownloaded).toBe(true);
  });

  it('returns clean diagnostic message when attempting transcription without installed model', async () => {
    const dummyWav = new ArrayBuffer(1024);
    const result = await runtime.transcribeAudio(dummyWav);
    expect(result).toContain('Local Whisper STT: Model not installed');
  });

  it('returns clean diagnostic message when model exists but whisper binary is missing', async () => {
    // Create mock model file
    const mockFilePath = path.join(testModelsDir, 'ggml-tiny.en.bin');
    fs.writeFileSync(mockFilePath, Buffer.alloc(1024 * 1024 + 100));

    const dummyWav = new ArrayBuffer(1024);
    const result = await runtime.transcribeAudio(dummyWav);
    expect(result).toContain('Whisper runtime binary not found');
  });
});
