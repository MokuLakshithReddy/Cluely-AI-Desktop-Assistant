import { useState, useEffect, useRef, useCallback } from 'react';
import { SharedState } from '../lib/types';

export const FALLBACK_STATE: SharedState = {
  appVersion: '1.0.0',
  isControlWindowLoaded: true,
  isChatWindowLoaded: true,
  isDashboardWindowLoaded: false,
  showChat: true,
  showDashboard: false,
  chatWindowIsExpanded: true,
  isStealthMode: true,
  meHasVoiceActivity: false,
  themHasVoiceActivity: false,
  isCapturingScreenshot: false,
  isRecording: false,
  activeMode: 'copilot',
  activeModel: 'gemini-2.5-flash',
  hasApiKeys: {
    gemini: false,
    openai: false,
    anthropic: false,
    groq: false,
    ollama: false,
  },
  shortcuts: {
    toggleVisibility: 'CommandOrControl+Shift+Space',
    ask: 'CommandOrControl+Enter',
    clear: 'Escape',
    toggleSession: 'CommandOrControl+Shift+X',
    moveUp: 'CommandOrControl+Up',
    moveDown: 'CommandOrControl+Down',
    moveLeft: 'CommandOrControl+Left',
    moveRight: 'CommandOrControl+Right',
  },
  session: null,
  knowledgeDocs: [],
};

export type StateUpdater =
  | Partial<SharedState>
  | ((prevState: SharedState) => Partial<SharedState>);

export function useSharedState() {
  const [state, setState] = useState<SharedState>(FALLBACK_STATE);
  const stateRef = useRef<SharedState>(state);

  // Keep stateRef synchronously up to date
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (window.desktopBridge) {
      window.desktopBridge
        .getSharedState()
        .then(s => {
          setState(s);
          stateRef.current = s;
        })
        .catch(console.error);

      const unsubscribe = window.desktopBridge.onSharedStateUpdated(newState => {
        setState(newState);
        stateRef.current = newState;
      });
      return unsubscribe;
    }
  }, []);

  const patchState = useCallback(async (updater: StateUpdater): Promise<SharedState> => {
    const prevState = stateRef.current;
    const patch = typeof updater === 'function' ? updater(prevState) : updater;
    const nextState = { ...prevState, ...patch };

    // Update locally immediately
    stateRef.current = nextState;
    setState(nextState);

    // Send clean patch to Electron
    if (window.desktopBridge) {
      try {
        await window.desktopBridge.patchSharedState(patch);
      } catch (e) {
        console.error('[useSharedState] Failed to patch state via IPC:', e);
      }
    }
    return nextState;
  }, []);

  const getLatestState = useCallback(() => {
    return stateRef.current;
  }, []);

  return { state, patchState, getLatestState };
}
