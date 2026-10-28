import { useState, useEffect } from 'react';
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
  apiKeys: {},
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

export function useSharedState() {
  const [state, setState] = useState<SharedState>(FALLBACK_STATE);

  useEffect(() => {
    if (window.desktopBridge) {
      window.desktopBridge.getSharedState().then(setState).catch(console.error);
      const unsubscribe = window.desktopBridge.onSharedStateUpdated(setState);
      return unsubscribe;
    }
  }, []);

  const patchState = async (patch: Partial<SharedState>) => {
    setState(prev => ({ ...prev, ...patch }));
    if (window.desktopBridge) {
      await window.desktopBridge.patchSharedState(patch);
    }
  };

  return { state, patchState };
}

