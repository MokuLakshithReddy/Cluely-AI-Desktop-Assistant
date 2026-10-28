import { useState, useRef } from 'react';
import { SharedState, ChatMessage } from '../lib/types';
import { streamGemini, streamOpenAI } from '../lib/providers';
import { retrieveRelevantPassages } from '../lib/knowledge';

export function useAiAssistant(
  state: SharedState,
  patchState: (patch: Partial<SharedState>) => Promise<void>
) {
  const [isGenerating, setIsGenerating] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const askAssistant = async (promptQuery: string, captureScreen: boolean = true) => {
    if (isGenerating) return;

    setIsGenerating(true);
    abortControllerRef.current = new AbortController();

    const messageId = `msg_${Date.now()}`;
    const userMessage: ChatMessage = {
      id: messageId,
      role: 'user',
      content: promptQuery || 'Analyze the current screen and conversation context',
      createdAt: new Date().toISOString(),
    };

    let screenshotBase64: string | undefined = undefined;

    // 1. Capture screen if requested
    if (captureScreen && window.desktopBridge) {
      try {
        const shot = await window.desktopBridge.captureScreenshot();
        screenshotBase64 = shot.data;
        userMessage.screenshot = shot.data;
      } catch (err) {
        console.warn('[AiAssistant] Screenshot capture error:', err);
      }
    }

    // 2. Retrieve relevant knowledge passages
    const retrievedDocs = retrieveRelevantPassages(
      promptQuery,
      state.knowledgeDocs || [],
      2
    );

    // 3. Initialize assistant response message
    const assistantMessageId = `asst_${Date.now()}`;
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      isStreaming: true,
      sources: retrievedDocs.length > 0 ? retrievedDocs : undefined,
    };

    const currentSession = state.session || {
      id: `sess_${Date.now()}`,
      createdAt: new Date().toISOString(),
      audioInputLanguage: 'en',
      transcript: [],
      messages: [],
    };

    const updatedMessages = [...currentSession.messages, userMessage, assistantMessage];
    await patchState({
      session: {
        ...currentSession,
        messages: updatedMessages,
      },
    });

    let streamedContent = '';

    try {
      const activeModel = state.activeModel;
      const recentTranscript = currentSession.transcript.slice(-15);

      if (activeModel.startsWith('gemini') || (!state.apiKeys.openai && state.apiKeys.gemini)) {
        await streamGemini({
          model: 'gemini-2.0-flash',
          apiKey: state.apiKeys.gemini,
          mode: state.activeMode,
          query: promptQuery,
          screenshotBase64,
          recentTranscript,
          knowledgePassages: retrievedDocs,
          signal: abortControllerRef.current.signal,
          onToken: token => {
            streamedContent += token;
            updateAssistantMessage(streamedContent, true);
          },
        });
      } else if (activeModel.startsWith('gpt') || state.apiKeys.openai) {
        await streamOpenAI({
          model: 'gpt-4o',
          apiKey: state.apiKeys.openai,
          mode: state.activeMode,
          query: promptQuery,
          screenshotBase64,
          recentTranscript,
          knowledgePassages: retrievedDocs,
          signal: abortControllerRef.current.signal,
          onToken: token => {
            streamedContent += token;
            updateAssistantMessage(streamedContent, true);
          },
        });
      } else {
        // Fallback demo mode when keys are not set yet
        const demoResponse = `**Context Received**\n- Screen Capture: ${screenshotBase64 ? 'Captured (1920x1080)' : 'None'}\n- Live Transcripts: ${recentTranscript.length} lines\n- Mode: **${state.activeMode.toUpperCase()}**\n\n*To enable live cloud LLM reasoning with multimodal vision, open Settings (Gear icon) and enter your Google Gemini or OpenAI API key.*`;
        streamedContent = demoResponse;
        updateAssistantMessage(streamedContent, false);
      }

      updateAssistantMessage(streamedContent, false);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        updateAssistantMessage(streamedContent + '\n\n*(Generation stopped by user)*', false);
      } else {
        console.error('[AiAssistant] Generation failed:', err);
        updateAssistantMessage(
          `**Error**: ${err.message || 'Failed to generate response. Check your API key and connection.'}`,
          false
        );
      }
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  const updateAssistantMessage = (content: string, isStreaming: boolean) => {
    patchState({
      session: {
        ...(state.session || {
          id: `sess_${Date.now()}`,
          createdAt: new Date().toISOString(),
          audioInputLanguage: 'en',
          transcript: [],
          messages: [],
        }),
        messages: (state.session?.messages || []).map(m =>
          m.isStreaming
            ? { ...m, content, isStreaming }
            : m
        ),
      },
    });
  };

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  return { askAssistant, stopGeneration, isGenerating };
}

