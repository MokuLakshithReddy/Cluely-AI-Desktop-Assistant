import React, { useState, useEffect } from 'react';
import { useSharedState } from './hooks/useSharedState';
import { useAudioCapture } from './hooks/useAudioCapture';
import { useAiAssistant } from './hooks/useAiAssistant';
import { FloatingBar } from './components/FloatingBar';
import { ChatPanel } from './components/ChatPanel';
import { Dashboard } from './components/Dashboard';

export function parseHashRoute(hashStr: string = (typeof window !== 'undefined' ? window.location.hash : '')): {
  route: string;
  tab?: string;
} {
  const clean = (hashStr || '').replace(/^#\/?/, '');
  const [routePart, queryPart] = clean.split('?');
  const route = routePart || 'all';
  let tab: string | undefined;
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    tab = params.get('tab') || undefined;
  }
  return { route, tab };
}

export function App() {
  const { state, patchState, getLatestState } = useSharedState();
  const [routeInfo, setRouteInfo] = useState(() =>
    typeof window !== 'undefined' ? parseHashRoute(window.location.hash) : { route: 'all' }
  );

  useEffect(() => {
    const handleHashChange = () => {
      setRouteInfo(parseHashRoute(window.location.hash));
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Dual-channel audio capture (mic + loopback) is gated to the primary audio owner
  const isAudioOwner = routeInfo.route === 'control' || routeInfo.route === 'all';
  useAudioCapture(state, patchState, getLatestState, isAudioOwner);

  // Initialize AI assistant handler with latest state updater
  const { askAssistant, stopGeneration, isGenerating } = useAiAssistant(
    state,
    patchState,
    getLatestState
  );

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

  if (routeInfo.route === 'control') {
    return (
      <div className="w-full h-full flex items-center justify-center p-0 m-0 bg-transparent overflow-hidden">
        <FloatingBar
          state={state}
          patchState={patchState}
          onAsk={() => askAssistant('', true)}
          isGenerating={isGenerating}
        />
      </div>
    );
  }

  if (routeInfo.route === 'chat') {
    return (
      <div className="w-full h-full p-1 bg-transparent overflow-hidden">
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

  if (routeInfo.route === 'dashboard') {
    return <Dashboard state={state} patchState={patchState} initialTab={routeInfo.tab as any} />;
  }

  // Combined Web / Preview Mode
  return (
    <div className="min-h-screen bg-slate-950 p-6 flex flex-col items-center justify-start space-y-4">
      {/* Top Web Navigation Toggle */}
      <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-800 p-1 rounded-full text-xs shadow-md">
        <button
          onClick={() => { window.location.hash = ''; }}
          className="px-3.5 py-1 rounded-full bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30 shadow-sm"
        >
          Copilot Floating Overlay
        </button>
        <button
          onClick={() => { window.location.hash = 'dashboard'; }}
          className="px-3.5 py-1 rounded-full text-slate-400 hover:text-slate-200 font-medium transition-colors"
        >
          Dashboard & Vault
        </button>
      </div>

      <div className="w-[490px]">
        <FloatingBar
          state={state}
          patchState={patchState}
          onAsk={() => askAssistant('', true)}
          isGenerating={isGenerating}
        />
      </div>

      {state.showChat && (
        <div className="w-[490px] h-[540px]">
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

