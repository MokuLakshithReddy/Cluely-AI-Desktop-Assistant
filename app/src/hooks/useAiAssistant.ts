import { useState, useRef } from 'react';
import { SharedState, ChatMessage, SessionRecord } from '../lib/types';
import { StateUpdater } from './useSharedState';
import { retrieveRelevantPassages } from '../lib/knowledge';

export function useAiAssistant(
  state: SharedState,
  patchState: (updater: StateUpdater) => Promise<SharedState>,
  getLatestState: () => SharedState
) {
  const [isGenerating, setIsGenerating] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeMessagesRef = useRef<ChatMessage[]>([]);
  const lastPatchTimeRef = useRef<number>(0);

  const askAssistant = async (promptQuery: string, captureScreen: boolean = true) => {
    if (isGenerating) return;

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    activeRequestIdRef.current = requestId;
    setIsGenerating(true);
    abortControllerRef.current = new AbortController();

    const currentState = getLatestState();
    const currentSession: SessionRecord = currentState.session || {
      id: `sess_${Date.now()}`,
      title: promptQuery ? promptQuery.slice(0, 32) : 'Conversation Session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationSeconds: 0,
      mode: currentState.activeMode,
      audioInputLanguage: 'en',
      transcript: [],
      messages: [],
    };

    // 1. Capture screen if requested
    let screenshotBase64: string | undefined = undefined;
    if (captureScreen && window.desktopBridge) {
      try {
        const shot = await window.desktopBridge.captureScreenshot();
        screenshotBase64 = shot.data;
      } catch (err) {
        console.warn('[useAiAssistant] Screenshot capture error:', err);
      }
    }

    // 2. Retrieve relevant knowledge passages
    const retrievedDocs = retrieveRelevantPassages(
      promptQuery,
      currentState.knowledgeDocs || [],
      2
    );

    // 3. Create User & Assistant message records
    const userMessage: ChatMessage = {
      id: `msg_u_${Date.now()}`,
      role: 'user',
      content: promptQuery || 'Analyze the visible screen and live conversation context',
      createdAt: new Date().toISOString(),
      screenshot: screenshotBase64,
    };

    const assistantMessageId = `msg_a_${Date.now()}`;
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      isStreaming: true,
      sources: retrievedDocs.length > 0 ? retrievedDocs : undefined,
    };

    // Update activeMessagesRef with the exact new list
    const existingMessages = currentSession.messages || [];
    activeMessagesRef.current = [...existingMessages, userMessage, assistantMessage];

    // Persist new message list to state using latest state functional updater
    await patchState(prev => {
      const activeSess = prev.session || currentSession;
      return {
        session: {
          ...activeSess,
          messages: [...activeMessagesRef.current],
        },
      };
    });

    let accumulatedContent = '';

    // Listen for streaming tokens from main process
    let unsubTokens: (() => void) | null = null;
    if (window.desktopBridge) {
      unsubTokens = window.desktopBridge.onAiTokenStream(token => {
        accumulatedContent += token;
        updateActiveAssistantMessage(assistantMessageId, accumulatedContent, true, false);
      });
    }

    try {
      const latestState = getLatestState();
      const recentTranscript = (latestState.session?.transcript || []).slice(-15);

      if (window.desktopBridge?.executeAiStream) {
        const result = await window.desktopBridge.executeAiStream({
          model: latestState.activeModel,
          mode: latestState.activeMode,
          query: promptQuery,
          screenshotBase64,
          recentTranscript,
          knowledgePassages: retrievedDocs,
          conversationHistory: existingMessages,
          requestId,
        });

        accumulatedContent = result.content;
      } else {
        // Fallback demo response if running outside Electron
        accumulatedContent = `**Screen Context Analyzed**\n- Screenshot Attached: ${screenshotBase64 ? 'Yes (1920x1080)' : 'No'}\n- Transcripts in context: ${recentTranscript.length} entries\n- Mode: **${latestState.activeMode.toUpperCase()}**\n\nConfigure your API keys in the Dashboard to enable live cloud LLM reasoning.`;
      }

      // Finalize message with complete content and isStreaming: false (force durable patch)
      updateActiveAssistantMessage(assistantMessageId, accumulatedContent, false, true);

      // Save complete session to SessionRepository with stripped screenshots
      const finalState = getLatestState();
      if (finalState.session && window.desktopBridge?.saveSessionRecord) {
        const sessionToPersist: SessionRecord = {
          ...finalState.session,
          messages: finalState.session.messages.map(m => {
            if (m.screenshot) {
              const { screenshot, ...rest } = m;
              return rest;
            }
            return m;
          }),
        };
        await window.desktopBridge.saveSessionRecord(sessionToPersist);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        accumulatedContent += '\n\n*(Generation stopped by user)*';
      } else {
        console.error('[useAiAssistant] AI generation error:', err);
        accumulatedContent = `**Generation Error**: ${err.message || 'Failed to complete request'}`;
      }
      updateActiveAssistantMessage(assistantMessageId, accumulatedContent, false, true);
    } finally {
      if (unsubTokens) unsubTokens();
      setIsGenerating(false);
      abortControllerRef.current = null;
      activeRequestIdRef.current = null;
    }
  };

  const updateActiveAssistantMessage = (
    msgId: string,
    content: string,
    isStreaming: boolean,
    forcePatch: boolean = false
  ) => {
    // Update activeMessagesRef
    activeMessagesRef.current = activeMessagesRef.current.map(m =>
      m.id === msgId ? { ...m, content, isStreaming } : m
    );

    const now = Date.now();
    // Only patch durable shared state if forced (start/finish/abort) or throttled (>150ms)
    if (forcePatch || !isStreaming || now - lastPatchTimeRef.current > 150) {
      lastPatchTimeRef.current = now;
      patchState(prev => {
        if (!prev.session) return {};
        return {
          session: {
            ...prev.session,
            messages: [...activeMessagesRef.current],
          },
        };
      });
    }
  };

  const stopGeneration = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const currentReqId = activeRequestIdRef.current;
    if (currentReqId && window.desktopBridge?.abortAiStream) {
      try {
        await window.desktopBridge.abortAiStream(currentReqId);
      } catch (err) {
        console.warn('[useAiAssistant] Failed to abort stream:', err);
      }
    }
  };

  return { askAssistant, stopGeneration, isGenerating };
}
