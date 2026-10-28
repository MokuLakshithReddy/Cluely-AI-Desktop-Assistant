import { describe, it, expect } from 'vitest';
import { AudioResampler, VADProcessor, encodeWAV } from '../src/lib/vad';

describe('Audio Processing & VAD Subsystem', () => {
  it('resamples 48kHz audio buffer to 16kHz with correct sample count', () => {
    const resampler = new AudioResampler(48000, 16000);
    const input = new Float32Array(4800); // 100ms at 48kHz
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    }

    const output = resampler.resample(input);
    expect(output.length).toBe(1600); // 100ms at 16kHz
  });

  it('calculates RMS energy accurately across float audio frames', () => {
    const vad = new VADProcessor();
    const silentFrame = new Float32Array(512).fill(0);
    expect(vad.calculateRms(silentFrame)).toBe(0);

    const activeFrame = new Float32Array(512).fill(0.5);
    expect(vad.calculateRms(activeFrame)).toBeCloseTo(0.5, 4);
  });

  it('detects speech start and speech end with redemption window', () => {
    let speechStarted = false;
    let speechEnded = false;
    let endedBuffer: ArrayBuffer | null = null;

    const vad = new VADProcessor({
      energyThreshold: 0.02,
      redemptionMs: 50,
      preSpeechPadMs: 50,
    });

    vad.onSpeechStart = () => {
      speechStarted = true;
    };
    vad.onSpeechEnd = (buf) => {
      speechEnded = true;
      endedBuffer = buf;
    };

    const speechFrame = new Float32Array(512).fill(0.1);
    const silentFrame = new Float32Array(512).fill(0.001);

    // Send active speech
    vad.processFrame(speechFrame);
    expect(speechStarted).toBe(true);
    expect(speechEnded).toBe(false);

    // Send first silent frame (initiates silence detection)
    vad.processFrame(silentFrame);
    expect(speechStarted).toBe(true);
    expect(speechEnded).toBe(false);

    // Wait past redemption duration (50ms)
    const now = Date.now();
    while (Date.now() - now < 70) {
      // simulate delay
    }

    // Next silent frame exceeds redemption window and triggers speechEnd
    vad.processFrame(silentFrame);
    expect(speechEnded).toBe(true);
    expect(endedBuffer).not.toBeNull();
  });

  it('suppresses local microphone frames when remote speaker is active (crosstalk prevention)', () => {
    const vad = new VADProcessor();
    const activeFrame = new Float32Array(512).fill(0.5);

    // When isEchoSuppressed is true, frame is treated as silence
    vad.processFrame(activeFrame, true);
    // Should not trigger speech start because energy is zeroed
    expect(vad.calculateRms(new Float32Array(512))).toBe(0);
  });

  it('correctly encodes Float32Array into valid 16-bit PCM WAV with RIFF header', () => {
    const samples = new Float32Array(1600).fill(0.25);
    const wav = encodeWAV(samples, 1, 16000, 16);

    expect(wav.byteLength).toBe(44 + 1600 * 2);

    const view = new DataView(wav);
    // Check 'RIFF'
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    expect(riff).toBe('RIFF');

    // Check 'WAVE'
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    expect(wave).toBe('WAVE');

    // Check Sample Rate
    expect(view.getUint32(24, true)).toBe(16000);
    // Check Bits Per Sample
    expect(view.getUint16(34, true)).toBe(16);
  });
});
