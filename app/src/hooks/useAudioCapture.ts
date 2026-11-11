import { useEffect, useRef } from 'react';
import { SharedState, TranscriptItem, Role } from '../lib/types';
import { StateUpdater } from './useSharedState';
import { AudioResampler, VADProcessor, arrayBufferToBase64 } from '../lib/vad';

export function useAudioCapture(
  state: SharedState,
  patchState: (updater: StateUpdater) => Promise<SharedState>,
  getLatestState: () => SharedState,
  isAudioOwner: boolean = true
) {
  const isRecording = state.isRecording;
  const isPurging = state.isPurging;
  const isEmergencyStopping = state.isEmergencyStopping;
  const captureSessionIdRef = useRef(0);
  // The effect can re-run while recording remains enabled (for example, when
  // emergency-stop/purge flags change). Keep startup idempotent for one capture
  // generation and block automatic restart after a fail-closed stop.
  const captureStartSessionRef = useRef<number | null>(null);
  const captureStopRequestedRef = useRef(false);

  // Local Microphone State
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const micVadRef = useRef<VADProcessor | null>(null);
  const micResamplerRef = useRef<AudioResampler | null>(null);

  // Remote System Audio Loopback State
  const systemStreamRef = useRef<MediaStream | null>(null);
  const systemAudioCtxRef = useRef<AudioContext | null>(null);
  const systemVadRef = useRef<VADProcessor | null>(null);
  const systemResamplerRef = useRef<AudioResampler | null>(null);

  useEffect(() => {
    if (!isAudioOwner) return;

    if (isPurging || isEmergencyStopping) {
      captureStopRequestedRef.current = true;
      stopDualCapture(false, true);
      if (isEmergencyStopping && !isPurging) void patchState({ isEmergencyStopping: false });
      return;
    }

    if (!isRecording) {
      const preserveFailure = captureStopRequestedRef.current;
      captureStopRequestedRef.current = false;
      captureStartSessionRef.current = null;
      stopDualCapture(true, !preserveFailure);
      return;
    }

    startDualCapture();

    return () => {
      // Let the next effect decide whether to reset to idle or preserve a failure status.
      stopDualCapture(!getLatestState().isPurging && !getLatestState().isEmergencyStopping, false);
    };
  }, [isRecording, isAudioOwner, isPurging, isEmergencyStopping]);

  const handleSpeechSegmentReady = async (
    role: Role,
    wavBuffer: ArrayBuffer,
    durationMs: number
  ) => {
    if (durationMs < 400 || getLatestState().isPurging) return; // Discard short clicks/pops and purge-time audio

    const transcriptId = `tr_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const placeholderItem: TranscriptItem = {
      id: transcriptId,
      createdAt: new Date().toISOString(),
      relativeMs: durationMs,
      role,
      status: 'transcribing',
      text: '',
    };

    // Append placeholder segment to active session
    await patchState(prev => {
      if (prev.isPurging) return {};
      const activeSession = prev.session || {
        id: `sess_${Date.now()}`,
        title: 'Live Conversation Session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        durationSeconds: 0,
        mode: prev.activeMode,
        audioInputLanguage: 'en',
        transcript: [],
        messages: [],
      };
      return {
        session: {
          ...activeSession,
          transcript: [...activeSession.transcript, placeholderItem],
        },
      };
    });

    const currentState = getLatestState();
    if (currentState.isPurging) return;
    const hasSttKey = currentState.hasApiKeys.groq || currentState.hasApiKeys.openai;

    if (!hasSttKey) {
      // Diagnostic mode: Do NOT inject fake conversation transcripts!
      // Mark as error with clear actionable reason
      await patchState(prev => {
        if (!prev.session || prev.isPurging) return {};
        return {
          session: {
            ...prev.session,
            transcript: prev.session.transcript.map(item =>
              item.id === transcriptId
                ? {
                    ...item,
                    status: 'error',
                    error: 'No STT key configured. Add Groq or OpenAI key in Settings.',
                    text: '[Speech detected - Configure STT Key in Settings]',
                  }
                : item
            ),
          },
        };
      });
      return;
    }

    // Call real transcription API via secure main process bridge
    try {
      const wavBase64 = arrayBufferToBase64(wavBuffer);
      let recognizedText = '';

      if (window.desktopBridge?.transcribeAudioPayload) {
        const res = await window.desktopBridge.transcribeAudioPayload({
          wavBase64,
          language: currentState.session?.audioInputLanguage || 'en',
        });
        recognizedText = res.text?.trim() || '';
      }

      if (!recognizedText) {
        // Remove empty segment cleanly
        await patchState(prev => {
          if (!prev.session) return {};
          return {
            session: {
              ...prev.session,
              transcript: prev.session.transcript.filter(item => item.id !== transcriptId),
            },
          };
        });
        return;
      }

      // Mark transcript segment as ready with actual transcribed text
      await patchState(prev => {
        if (!prev.session) return {};
        return {
          session: {
            ...prev.session,
            transcript: prev.session.transcript.map(item =>
              item.id === transcriptId
                ? { ...item, status: 'ready', text: recognizedText }
                : item
            ),
          },
        };
      });
    } catch (err: any) {
      console.warn(`[useAudioCapture] Transcription error for ${role}:`, err);
      // Clearly represent failed transcription as an error state
      await patchState(prev => {
        if (!prev.session) return {};
        return {
          session: {
            ...prev.session,
            transcript: prev.session.transcript.map(item =>
              item.id === transcriptId
                ? {
                    ...item,
                    status: 'error',
                    error: err.message || 'Transcription service error',
                    text: `[Transcription Failed: ${err.message || 'Error'}]`,
                  }
                : item
            ),
          },
        };
      });
    }
  };

  const startDualCapture = async () => {
    if (getLatestState().isPurging || captureStopRequestedRef.current) return;
    if (captureStartSessionRef.current === captureSessionIdRef.current) return;
    const currentSessionId = ++captureSessionIdRef.current;
    captureStartSessionRef.current = currentSessionId;
    await patchState({
      microphoneCaptureStatus: 'starting',
      systemAudioCaptureStatus: 'starting',
      captureWarning: null,
    });

    // A live capture must not silently continue after an OS/device track ends.
    // The generation check prevents stale "ended" events from a previous session
    // from stopping a newer recording or racing with an explicit stop/purge.
    const stopForUnexpectedTrackEnd = (role: Role, source: string) => {
      if (captureSessionIdRef.current !== currentSessionId) return;
      const latest = getLatestState();
      if (!latest.isRecording || latest.isPurging || latest.isEmergencyStopping) return;

      const message = `${source} capture ended unexpectedly. Recording was stopped.`;
      console.warn(`[useAudioCapture] ${message}`);
      captureStopRequestedRef.current = true;
      stopDualCapture(false, false);

      void patchState(prev => {
        if (!prev.isRecording || prev.isPurging || prev.isEmergencyStopping) return {};
        const now = new Date().toISOString();
        const activeSession = prev.session || {
          id: `sess_${Date.now()}`,
          title: 'Live Conversation Session',
          createdAt: now,
          updatedAt: now,
          durationSeconds: 0,
          mode: prev.activeMode,
          audioInputLanguage: 'en',
          transcript: [],
          messages: [],
        };
        const errorItem: TranscriptItem = {
          id: `tr_capture_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          createdAt: now,
          relativeMs: 0,
          role,
          status: 'error',
          error: message,
          text: `[Capture stopped: ${message}]`,
        };

        return {
          isRecording: false,
          meHasVoiceActivity: false,
          themHasVoiceActivity: false,
          microphoneCaptureStatus: role === 'me' ? 'error' : 'idle',
          systemAudioCaptureStatus: role === 'them' ? 'error' : 'idle',
          captureWarning: message.slice(0, 256),
          session: {
            ...activeSession,
            updatedAt: now,
            transcript: [...activeSession.transcript, errorItem],
          },
        };
      }).catch(error => {
        console.error('[useAudioCapture] Failed to persist unexpected track-end state:', error);
      });
    };

    const watchAudioTracks = (stream: MediaStream, role: Role, source: string) => {
      stream.getAudioTracks().forEach(track => {
        const handleEnded = () => stopForUnexpectedTrackEnd(role, source);
        track.addEventListener('ended', handleEnded, { once: true });
        // Handle a device that disappears between stream resolution and listener setup.
        if (track.readyState === 'ended') handleEnded();
      });
    };

    // 1. Channel A: Start Local Microphone Capture ('me')
    if (!navigator?.mediaDevices?.getUserMedia) {
      const message = 'Microphone capture is not supported in this environment.';
      console.warn('[useAudioCapture] ' + message);
      captureStopRequestedRef.current = true;
      stopDualCapture(false, false);
      await patchState({
        isRecording: false,
        meHasVoiceActivity: false,
        microphoneCaptureStatus: 'unavailable',
        systemAudioCaptureStatus: 'idle',
        captureWarning: message,
      });
      return;
    }

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });

      // Abort and stop tracks if recording stopped or session changed while prompt was active
      if (captureSessionIdRef.current !== currentSessionId || !getLatestState().isRecording || getLatestState().isPurging) {
        micStream.getTracks().forEach(t => t.stop());
        return;
      }

      micStreamRef.current = micStream;
      watchAudioTracks(micStream, 'me', 'Microphone');
      if (captureSessionIdRef.current !== currentSessionId) return;

      const micAudioCtx = new AudioContext({ sampleRate: 48000 });
      micAudioCtxRef.current = micAudioCtx;
      const micSource = micAudioCtx.createMediaStreamSource(micStream);
      const micResampler = new AudioResampler(48000, 16000);
      micResamplerRef.current = micResampler;

      const micVad = new VADProcessor();
      micVadRef.current = micVad;

      micVad.onSpeechStart = () => {
        patchState({ meHasVoiceActivity: true });
      };
      micVad.onSpeechEnd = (wav, duration) => {
        patchState({ meHasVoiceActivity: false });
        handleSpeechSegmentReady('me', wav, duration);
      };

      const micScriptNode = micAudioCtx.createScriptProcessor(4096, 1, 1);
      micScriptNode.onaudioprocess = event => {
        const inputData = event.inputBuffer.getChannelData(0);
        const resampled = micResampler.resample(inputData);

        // Keep microphone and loopback as independent sources. Remote activity must not
        // erase genuine local speech when both speakers talk at the same time.
        micVad.processFrame(resampled);
      };

      micSource.connect(micScriptNode);
      micScriptNode.connect(micAudioCtx.destination);
      await patchState({ microphoneCaptureStatus: 'active' });
    } catch (err: any) {
      if (captureSessionIdRef.current !== currentSessionId) return;
      console.warn('[useAudioCapture] Microphone access not granted or unavailable:', err?.message || err);
      // Release any stream/context created before the failure (for example, if
      // AudioContext construction fails after getUserMedia succeeds).
      captureStopRequestedRef.current = true;
      stopDualCapture(false, false);
      const captureError = err?.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : `Microphone capture failed: ${err?.message || 'device unavailable'}`;
      // Gracefully reset recording state while keeping the failure visible until the next attempt.
      await patchState(prev => {
        if (prev.isPurging) return {};
        const activeSession = prev.session || {
          id: `sess_${Date.now()}`,
          title: 'Live Conversation Session',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          durationSeconds: 0,
          mode: prev.activeMode,
          audioInputLanguage: 'en',
          transcript: [],
          messages: [],
        };
        return {
          isRecording: false,
          meHasVoiceActivity: false,
          microphoneCaptureStatus: 'error',
          systemAudioCaptureStatus: 'idle',
          captureWarning: captureError.slice(0, 256),
          session: {
            ...activeSession,
            transcript: [
              ...activeSession.transcript,
              {
                id: `tr_mic_perm_${Date.now()}`,
                createdAt: new Date().toISOString(),
                relativeMs: 0,
                role: 'me',
                status: 'error',
                error: captureError,
                text: `[${captureError}]`,
              },
            ],
          },
        };
      });
      return;
    }

    // 2. Channel B: Start Remote System Audio Loopback Capture ('them')
    try {
      if (!navigator.mediaDevices.getDisplayMedia) {
        const message = 'System-audio loopback is not supported in this environment. Microphone capture is still active.';
        await patchState({
          systemAudioCaptureStatus: 'unavailable',
          captureWarning: message,
        });
        return;
      }

      {
        // In Electron, setDisplayMediaRequestHandler provides screen video + loopback audio
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        // Abort and stop tracks if recording stopped or session changed while prompt was active
        if (
          captureSessionIdRef.current !== currentSessionId ||
          !getLatestState().isRecording ||
          getLatestState().isPurging
        ) {
          displayStream.getTracks().forEach(t => t.stop());
          return;
        }

        // Disable and stop the video track immediately to conserve CPU and GPU
        displayStream.getVideoTracks().forEach(track => {
          track.enabled = false;
          track.stop();
        });

        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
          const message = 'System-audio loopback was not provided by the operating system. Microphone capture is still active.';
          await patchState({
            systemAudioCaptureStatus: 'unavailable',
            captureWarning: message,
          });
        } else {
          systemStreamRef.current = new MediaStream(audioTracks);
          watchAudioTracks(systemStreamRef.current, 'them', 'System-audio loopback');
          if (captureSessionIdRef.current !== currentSessionId) return;

          const systemAudioCtx = new AudioContext({ sampleRate: 48000 });
          systemAudioCtxRef.current = systemAudioCtx;
          const systemSource = systemAudioCtx.createMediaStreamSource(systemStreamRef.current);
          const systemResampler = new AudioResampler(48000, 16000);
          systemResamplerRef.current = systemResampler;

          const systemVad = new VADProcessor();
          systemVadRef.current = systemVad;

          systemVad.onSpeechStart = () => {
            patchState({ themHasVoiceActivity: true });
          };
          systemVad.onSpeechEnd = (wav, duration) => {
            patchState({ themHasVoiceActivity: false });
            handleSpeechSegmentReady('them', wav, duration);
          };

          const systemScriptNode = systemAudioCtx.createScriptProcessor(4096, 1, 1);
          systemScriptNode.onaudioprocess = event => {
            const inputData = event.inputBuffer.getChannelData(0);
            const resampled = systemResampler.resample(inputData);
            systemVad.processFrame(resampled);
          };

          systemSource.connect(systemScriptNode);
          systemScriptNode.connect(systemAudioCtx.destination);
          await patchState({
            systemAudioCaptureStatus: 'active',
            captureWarning: null,
          });
        }
      }
    } catch (err: any) {
      // The OS may deny or decline loopback while leaving microphone capture usable.
      const message = `System-audio loopback is unavailable: ${err?.message || 'permission was not granted'}. Microphone capture is still active.`;
      console.info('[useAudioCapture] ' + message);
      if (captureSessionIdRef.current === currentSessionId && getLatestState().isRecording && !getLatestState().isPurging) {
        await patchState({
          systemAudioCaptureStatus: 'unavailable',
          captureWarning: message.slice(0, 256),
        });
      }
    }
  };

  const stopDualCapture = (
    flushPendingSpeech: boolean = true,
    resetCaptureStatus: boolean = true
  ) => {
    captureSessionIdRef.current++;

    // Stop Microphone
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    if (micAudioCtxRef.current) {
      micAudioCtxRef.current.close().catch(() => {});
      micAudioCtxRef.current = null;
    }
    if (micVadRef.current) {
      if (flushPendingSpeech) micVadRef.current.flush();
        else micVadRef.current.discard();
      micVadRef.current = null;
    }

    // Stop System Audio
    if (systemStreamRef.current) {
      systemStreamRef.current.getTracks().forEach(t => t.stop());
      systemStreamRef.current = null;
    }
    if (systemAudioCtxRef.current) {
      systemAudioCtxRef.current.close().catch(() => {});
      systemAudioCtxRef.current = null;
    }
    if (systemVadRef.current) {
      if (flushPendingSpeech) systemVadRef.current.flush();
        else systemVadRef.current.discard();
      systemVadRef.current = null;
    }

    patchState({
      meHasVoiceActivity: false,
      themHasVoiceActivity: false,
      ...(resetCaptureStatus ? {
        microphoneCaptureStatus: 'idle' as const,
        systemAudioCaptureStatus: 'idle' as const,
        captureWarning: null,
      } : {}),
    });
  };
}
