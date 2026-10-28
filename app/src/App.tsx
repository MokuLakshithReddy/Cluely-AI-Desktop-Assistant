import React, { useState, useEffect } from 'react';
import { useSharedState } from './hooks/useSharedState';
import { useAudioCapture } from './hooks/useAudioCapture';
import { useAiAssistant } from './hooks/useAiAssistant';
import { FloatingBar } from './components/FloatingBar';
import { ChatPanel } from './components/ChatPanel';
import { Dashboard } from './components/Dashboard';

export function App() {
  const { state, patchState } = useSharedState();
  const [route, setRoute] = useState(window.location.hash.replace('#', '') || 'all');

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(window.location.hash.replace('#', '') || 'all');
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Initialize live audio capture and VAD
  useAudioCapture(state, patchState);

  // Initialize AI assistant handler
  const { askAssistant, stopGeneration, isGenerating } = useAiAssistant(state, patchState);

  // Listen for global shortcut triggers from main process
  useEffect(() => {
    if (window.desktopBridge) {
      const unsub = window.desktopBridge.onShortcutAction(action => {
        if (action === 'ask') {
          askAssistant('', true);
        } else if (action === 'clear') {
          patchState({ showChat: false });
        }
      });
      return unsub;
    }
  }, [askAssistant, patchState]);

  if (route === 'control') {
    return (
      <div className="w-full h-full p-1 bg-transparent">
        <FloatingBar
          state={state}
          patchState={patchState}
          onAsk={() => askAssistant('', true)}
          isGenerating={isGenerating}
        />
      </div>
    );
  }

  if (route === 'chat') {
    return (
      <div className="w-full h-screen p-1 bg-transparent">
        <ChatPanel
          state={state}
          patchState={patchState}
          onAsk={askAssistant}
          onStop={stopGeneration}
          isGenerating={isGenerating}
        />
      </div>
    );
  }

  if (route === 'dashboard') {
    return <Dashboard state={state} patchState={patchState} />;
  }

  // Combined Web / Preview Mode
  return (
    <div className="min-h-screen bg-slate-950 p-6 flex flex-col items-center justify-start space-y-4">
      <div className="w-[420px]">
        <FloatingBar
          state={state}
          patchState={patchState}
          onAsk={() => askAssistant('', true)}
          isGenerating={isGenerating}
        />
      </div>

      {state.showChat && (
        <div className="w-[440px] h-[540px]">
          <ChatPanel
            state={state}
            patchState={patchState}
            onAsk={askAssistant}
            onStop={stopGeneration}
            isGenerating={isGenerating}
          />
        </div>
      )}
    </div>
  );
}

export default App;

