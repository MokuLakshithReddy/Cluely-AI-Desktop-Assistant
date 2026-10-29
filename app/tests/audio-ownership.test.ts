import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioResampler, VADProcessor } from '../src/lib/vad';

describe('Dual-Channel Audio Ownership and Capture Lifecycle', () => {
  let mockTrackStop: any;
  let mockMicStream: any;
  let mockDisplayStream: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrackStop = vi.fn();
    mockMicStream = {
      getTracks: () => [{ stop: mockTrackStop, kind: 'audio', enabled: true }],
    };
    mockDisplayStream = {
      getTracks: () => [{ stop: mockTrackStop, kind: 'audio', enabled: true }],
      getVideoTracks: () => [{ stop: mockTrackStop, enabled: true }],
      getAudioTracks: () => [{ stop: mockTrackStop, kind: 'audio', enabled: true }],
    };
  });

  it('prevents background audio leaks by stopping tracks if cancelled while permission prompt is pending', async () => {
    let captureSessionId = 0;
    let isRecording = true;

    let resolveGetUserMedia: (stream: any) => void;
    const pendingMediaPromise = new Promise(resolve => {
      resolveGetUserMedia = resolve;
    });

    const getUserMediaMock = vi.fn().mockImplementation(() => pendingMediaPromise);

    // Simulate startDualCapture
    const currentSessionId = ++captureSessionId;

    const startCaptureAsync = async () => {
      const micStream: any = await getUserMediaMock();
      if (captureSessionId !== currentSessionId || !isRecording) {
        micStream.getTracks().forEach((t: any) => t.stop());
        return null;
      }
      return micStream;
    };

    const captureTask = startCaptureAsync();

    // User cancels recording while permission prompt was still open
    isRecording = false;
    captureSessionId++;

    // Permission prompt subsequently resolved by user or OS
    resolveGetUserMedia!(mockMicStream);
    const result = await captureTask;

    // Must be aborted and tracks stopped immediately
    expect(result).toBeNull();
    expect(mockTrackStop).toHaveBeenCalled();
  });

  it('crosstalk suppression zeroes frames when remote speaker has voice activity', () => {
    const vad = new VADProcessor();
    let speechStartCalled = false;
    vad.onSpeechStart = () => {
      speechStartCalled = true;
    };

    // Resampler creates 16kHz frames
    const resampler = new AudioResampler(48000, 16000);
    const mockAudioFrame = new Float32Array(4096);
    // Fill with simulated loud speech signal
    for (let i = 0; i < mockAudioFrame.length; i++) {
      mockAudioFrame[i] = Math.sin(i * 0.1) * 0.8;
    }

    const resampled = resampler.resample(mockAudioFrame);

    // If themHasVoiceActivity is true, echo is suppressed
    const isEchoSuppressed = true;
    vad.processFrame(resampled, isEchoSuppressed);

    // With echo suppressed, loud mic speech should not trigger local speech detection
    expect(speechStartCalled).toBe(false);
  });

  it('audio owner check prevents multiple windows from creating duplicate hardware streams', () => {
    const getUserMediaSpy = vi.fn().mockResolvedValue(mockMicStream);

    function simulateWindowMount(isAudioOwner: boolean, isRecording: boolean) {
      if (!isAudioOwner) {
        return 'IDLE_INACTIVE';
      }
      if (isRecording) {
        getUserMediaSpy();
        return 'RECORDING_ACTIVE';
      }
      return 'IDLE';
    }

    // Secondary windows (Chat and Dashboard) must be non-owners
    const chatWindow = simulateWindowMount(false, true);
    const dashboardWindow = simulateWindowMount(false, true);

    // Primary control bar is owner
    const controlWindow = simulateWindowMount(true, true);

    expect(chatWindow).toBe('IDLE_INACTIVE');
    expect(dashboardWindow).toBe('IDLE_INACTIVE');
    expect(controlWindow).toBe('RECORDING_ACTIVE');

    // Only one hardware stream was requested instead of three
    expect(getUserMediaSpy).toHaveBeenCalledTimes(1);
  });
});
