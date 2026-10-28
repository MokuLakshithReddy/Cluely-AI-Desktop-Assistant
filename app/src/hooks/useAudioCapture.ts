import { useEffect, useRef } from 'react';
import { SharedState, TranscriptItem } from '../lib/types';
import { AudioResampler, VADProcessor } from '../lib/vad';
import { transcribeAudio } from '../lib/providers';

export function useAudioCapture(state: SharedState, patchState: (patch: Partial<SharedState>) => Promise<void>) {
  const isRecording = state.isRecording;
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<VADProcessor | null>(null);
  const resamplerRef = useRef<AudioResampler | null>(null);

  useEffect(() => {
    if (!isRecording) {
      stopCapture();
      return;
    }

    startCapture();

    return () => {
      stopCapture();
    };
  }, [isRecording]);

  const startCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });
      mediaStreamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 48000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const resampler = new AudioResampler(48000, 16000);
      resamplerRef.current = resampler;

      const vad = new VADProcessor();
      vadRef.current = vad;

      vad.onSpeechStart = () => {
        patchState({ meHasVoiceActivity: true });
      };

      vad.onSpeechEnd = async (wavBuffer, durationMs) => {
        patchState({ meHasVoiceActivity: false });
        if (durationMs < 400) return; // Discard tiny clicks/noise

        const transcriptId = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const newItem: TranscriptItem = {
          id: transcriptId,
          createdAt: new Date().toISOString(),
          relativeMs: durationMs,
          role: 'me',
          status: 'transcribing',
          text: '...',
        };

        // Append placeholder to session
        const currentSession = state.session || {
          id: `sess_${Date.now()}`,
          createdAt: new Date().toISOString(),
          audioInputLanguage: 'en',
          transcript: [],
          messages: [],
        };

        const updatedTranscript = [...currentSession.transcript, newItem];
        await patchState({
          session: {
            ...currentSession,
            transcript: updatedTranscript,
          },
        });

        // Call STT API if key is available, else provide mock transcription
        const apiKey = state.apiKeys.groq || state.apiKeys.openai;
        let recognizedText = '';

        if (apiKey) {
          try {
            const provider = state.apiKeys.groq ? 'groq' : 'openai';
            recognizedText = await transcribeAudio(wavBuffer, apiKey, provider);
          } catch (err) {
            console.warn('[AudioCapture] Cloud STT error:', err);
            recognizedText = '[Audio captured - transcribe error]';
          }
        } else {
          recognizedText = 'Speech segment detected (configure Groq/OpenAI key in Settings for cloud Whisper)';
        }

        // Update transcript entry
        if (recognizedText) {
          const finalTranscript = updatedTranscript.map(item =>
            item.id === transcriptId ? { ...item, status: 'ready' as const, text: recognizedText } : item
          );
          await patchState({
            session: {
              ...currentSession,
              transcript: finalTranscript,
            },
          });
        }
      };

      // ScriptProcessor / AudioWorklet for frame processing
      const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
      scriptNode.onaudioprocess = event => {
        const inputData = event.inputBuffer.getChannelData(0);
        const resampled = resampler.resample(inputData);

        // Echo suppression: zero out if remote speaker ('them') is active
        const isEchoSuppressed = state.themHasVoiceActivity;
        vad.processFrame(resampled, isEchoSuppressed);
      };

      source.connect(scriptNode);
      scriptNode.connect(audioCtx.destination);
    } catch (err) {
      console.error('[AudioCapture] Failed to access microphone:', err);
      patchState({ isRecording: false });
    }
  };

  const stopCapture = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }
    if (vadRef.current) {
      vadRef.current.flush();
      vadRef.current = null;
    }
    patchState({ meHasVoiceActivity: false, themHasVoiceActivity: false });
  };
}

