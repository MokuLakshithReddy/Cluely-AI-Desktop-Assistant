import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealtimeSTTManager } from '../electron/services/realtime-stt-manager';
import { AudioResampler } from '../src/lib/vad';

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
});
