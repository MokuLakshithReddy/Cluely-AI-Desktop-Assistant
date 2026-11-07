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

  it('preserves overlapping microphone and system speech in separate VAD instances', () => {
    const micVad = new VADProcessor({ energyThreshold: 0.02 });
    const systemVad = new VADProcessor({ energyThreshold: 0.02 });
    const micStarted = vi.fn();
    const systemStarted = vi.fn();
    micVad.onSpeechStart = micStarted;
    systemVad.onSpeechStart = systemStarted;

    const speechFrame = new Float32Array(512);
    for (let i = 0; i < speechFrame.length; i++) {
      speechFrame[i] = Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.3;
    }

    expect(micVad.processFrame(speechFrame)).toBe(true);
    expect(systemVad.processFrame(speechFrame)).toBe(true);
    expect(micStarted).toHaveBeenCalledTimes(1);
    expect(systemStarted).toHaveBeenCalledTimes(1);
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

