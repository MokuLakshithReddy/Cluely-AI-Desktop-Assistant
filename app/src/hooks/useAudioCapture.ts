import { useEffect, useRef } from 'react';
import { SharedState, TranscriptItem, Role } from '../lib/types';
import { StateUpdater } from './useSharedState';
import { AudioResampler, VADProcessor, arrayBufferToBase64 } from '../lib/vad';

export function useAudioCapture(
  state: SharedState,
  patchState: (updater: StateUpdater) => Promise<SharedState>,
  getLatestState: () => SharedState
) {
  const isRecording = state.isRecording;

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
    if (!isRecording) {
      stopDualCapture();
      return;
    }

    startDualCapture();

    return () => {
      stopDualCapture();
    };
  }, [isRecording]);

  const handleSpeechSegmentReady = async (
    role: Role,
    wavBuffer: ArrayBuffer,
    durationMs: number
  ) => {
    if (durationMs < 400) return; // Discard short clicks/pops

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
    const hasSttKey = currentState.hasApiKeys.groq || currentState.hasApiKeys.openai;

    if (!hasSttKey) {
      // Diagnostic mode: Do NOT inject fake conversation transcripts!
      // Mark as error with clear actionable reason
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
    // 1. Channel A: Start Local Microphone Capture ('me')
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });
      micStreamRef.current = micStream;

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

        // Crosstalk Suppression: Zero mic frame if remote system audio is actively speaking!
        const isEchoSuppressed = getLatestState().themHasVoiceActivity;
        micVad.processFrame(resampled, isEchoSuppressed);
      };

      micSource.connect(micScriptNode);
      micScriptNode.connect(micAudioCtx.destination);
    } catch (err) {
      console.error('[useAudioCapture] Failed to access local microphone:', err);
    }

    // 2. Channel B: Start Remote System Audio Loopback Capture ('them')
    try {
      if (navigator.mediaDevices.getDisplayMedia) {
        // In Electron, setDisplayMediaRequestHandler provides screen video + loopback audio
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        // Disable and stop the video track immediately to conserve CPU and GPU
        displayStream.getVideoTracks().forEach(track => {
          track.enabled = false;
          track.stop();
        });

        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length > 0) {
          systemStreamRef.current = new MediaStream(audioTracks);

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
            systemVad.processFrame(resampled, false);
          };

          systemSource.connect(systemScriptNode);
          systemScriptNode.connect(systemAudioCtx.destination);
        }
      }
    } catch (err) {
      // Loopback media prompt dismissed or not supported on this platform
      console.info('[useAudioCapture] System audio loopback not attached:', err);
    }
  };

  const stopDualCapture = () => {
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
      micVadRef.current.flush();
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
      systemVadRef.current.flush();
      systemVadRef.current = null;
    }

    patchState({ meHasVoiceActivity: false, themHasVoiceActivity: false });
  };
}
