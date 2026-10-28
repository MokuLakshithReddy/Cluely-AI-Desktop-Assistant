import { describe, it, expect } from 'vitest';
import { AudioResampler, VADProcessor, encodeWAV } from '../src/lib/vad';

describe('Audio Processing, VAD & Crosstalk Subsystem', () => {
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

  it('calculates Zero-Crossing Rate (ZCR) to distinguish human speech frequencies', () => {
    const vad = new VADProcessor();
    // Alternating sign array has maximum ZCR = 1.0
    const alternating = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1]);
    expect(vad.calculateZcr(alternating)).toBe(7 / 8);

    // Constant DC has ZCR = 0.0
    const dc = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(vad.calculateZcr(dc)).toBe(0);
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

    // Create a speech frame with reasonable energy and speech-like ZCR (~0.1)
    const speechFrame = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      speechFrame[i] = Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.3;
    }
    const silentFrame = new Float32Array(512).fill(0);

    // Send active speech
    vad.processFrame(speechFrame);
    expect(speechStarted).toBe(true);
    expect(speechEnded).toBe(false);

    // Send first silent frame
    vad.processFrame(silentFrame);
    expect(speechStarted).toBe(true);
    expect(speechEnded).toBe(false);

    // Wait past redemption duration (50ms)
    const now = Date.now();
    while (Date.now() - now < 70) {}

    // Next silent frame exceeds redemption window and triggers speechEnd
    vad.processFrame(silentFrame);
    expect(speechEnded).toBe(true);
    expect(endedBuffer).not.toBeNull();
  });

  it('suppresses local microphone frames when remote speaker is active (crosstalk prevention)', () => {
    const vad = new VADProcessor();
    const activeFrame = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      activeFrame[i] = Math.sin(i) * 0.4;
    }

    // When isEchoSuppressed is true, frame is treated as silence
    const isSpeaking = vad.processFrame(activeFrame, true);
    expect(isSpeaking).toBe(false);
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
