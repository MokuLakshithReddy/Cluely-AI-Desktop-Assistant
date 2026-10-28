/**
 * Voice Activity Detection (VAD) & Audio Pipeline
 * Features:
 * - 48kHz to 16kHz downsampling
 * - Voice Activity Detection with 300ms redemption and 20s max segment
 * - Crosstalk / Echo suppression (zeros local mic if system audio is active)
 * - 16-bit PCM RIFF WAV encoder
 */

export interface VADConfig {
  sampleRate: number;
  frameSize: number;
  energyThreshold: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  maxSegmentMs: number;
}

export const DEFAULT_VAD_CONFIG: VADConfig = {
  sampleRate: 16000,
  frameSize: 512,
  energyThreshold: 0.015,
  redemptionMs: 300,
  preSpeechPadMs: 300,
  maxSegmentMs: 20000,
};

export class AudioResampler {
  private inRate: number;
  private outRate: number;

  constructor(inRate: number = 48000, outRate: number = 16000) {
    this.inRate = inRate;
    this.outRate = outRate;
  }

  resample(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input;
    const ratio = this.inRate / this.outRate;
    const outLength = Math.round(input.length / ratio);
    const output = new Float32Array(outLength);

    for (let i = 0; i < outLength; i++) {
      const srcIdx = i * ratio;
      const lower = Math.floor(srcIdx);
      const upper = Math.min(lower + 1, input.length - 1);
      const fraction = srcIdx - lower;
      output[i] = input[lower] * (1 - fraction) + input[upper] * fraction;
    }

    return output;
  }
}

export class VADProcessor {
  private config: VADConfig;
  private isSpeaking = false;
  private speechStartTimestamp: number | null = null;
  private silenceStartTimestamp: number | null = null;
  private speechBuffer: Float32Array[] = [];
  private preSpeechBuffer: Float32Array[] = [];
  private preSpeechMaxFrames: number;

  public onSpeechStart?: () => void;
  public onSpeechEnd?: (wavBuffer: ArrayBuffer, durationMs: number) => void;

  constructor(config: Partial<VADConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    this.preSpeechMaxFrames = Math.ceil(
      (this.config.preSpeechPadMs / 1000) * (this.config.sampleRate / this.config.frameSize)
    );
  }

  /**
   * Calculate Root Mean Square (RMS) energy of an audio frame
   */
  public calculateRms(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      sum += frame[i] * frame[i];
    }
    return Math.sqrt(sum / frame.length);
  }

  /**
   * Process a 16kHz audio frame
   */
  public processFrame(frame: Float32Array, isEchoSuppressed: boolean = false): void {
    if (isEchoSuppressed) {
      // If echo suppression is active, treat frame as pure silence
      frame = new Float32Array(frame.length);
    }

    const energy = this.calculateRms(frame);
    const now = Date.now();
    const hasVoice = energy > this.config.energyThreshold;

    if (hasVoice) {
      this.silenceStartTimestamp = null;
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartTimestamp = now;
        this.speechBuffer = [...this.preSpeechBuffer];
        this.onSpeechStart?.();
      }
      this.speechBuffer.push(frame);

      // Check max segment timeout (e.g. 20s)
      if (this.speechStartTimestamp && now - this.speechStartTimestamp >= this.config.maxSegmentMs) {
        this.finalizeSegment(now);
      }
    } else {
      if (this.isSpeaking) {
        this.speechBuffer.push(frame);
        if (!this.silenceStartTimestamp) {
          this.silenceStartTimestamp = now;
        } else if (now - this.silenceStartTimestamp >= this.config.redemptionMs) {
          this.finalizeSegment(now);
        }
      } else {
        // Maintain ring buffer of pre-speech audio
        this.preSpeechBuffer.push(frame);
        if (this.preSpeechBuffer.length > this.preSpeechMaxFrames) {
          this.preSpeechBuffer.shift();
        }
      }
    }
  }

  private finalizeSegment(now: number) {
    if (this.speechBuffer.length === 0) return;

    // Concatenate all frames in speechBuffer
    const totalSamples = this.speechBuffer.reduce((sum, f) => sum + f.length, 0);
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const buf of this.speechBuffer) {
      merged.set(buf, offset);
      offset += buf.length;
    }

    const durationMs = this.speechStartTimestamp ? now - this.speechStartTimestamp : 0;
    const wav = encodeWAV(merged, 1, this.config.sampleRate, 16);

    this.isSpeaking = false;
    this.speechStartTimestamp = null;
    this.silenceStartTimestamp = null;
    this.speechBuffer = [];
    this.preSpeechBuffer = [];

    this.onSpeechEnd?.(wav, durationMs);
  }

  public flush(): void {
    if (this.isSpeaking) {
      this.finalizeSegment(Date.now());
    }
  }
}

/**
 * Encodes Float32 PCM samples into a valid 16-bit Mono RIFF WAVE ArrayBuffer
 */
export function encodeWAV(
  samples: Float32Array,
  numChannels: number = 1,
  sampleRate: number = 16000,
  bitDepth: number = 16
): ArrayBuffer {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // RIFF Chunk Descriptor
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');

  // fmt sub-chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // ByteRate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data sub-chunk
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Write PCM 16-bit signed samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const intSample = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return buffer;
}

/**
 * Convert ArrayBuffer to base64 string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

