import React from 'react';
import {
  Mic,
  MicOff,
  Camera,
  Shield,
  ShieldOff,
  Settings,
  ChevronDown,
  ChevronUp,
  GripHorizontal,
  Sparkles,
  Minus,
  X,
} from 'lucide-react';
import { SharedState, AssistantMode } from '../lib/types';
import { StateUpdater } from '../hooks/useSharedState';

interface FloatingBarProps {
  state: SharedState;
  patchState: (updater: StateUpdater) => Promise<SharedState>;
  onAsk: () => void;
  isGenerating?: boolean;
}

export const FloatingBar: React.FC<FloatingBarProps> = ({
  state,
  patchState,
  onAsk,
  isGenerating,
}) => {
  const [showConsentModal, setShowConsentModal] = React.useState(false);

  const toggleRecording = () => {
    if (!state.isRecording) {
      if (state.meetingConsent !== 'allowed_once' && state.meetingConsent !== 'always_allowed') {
        setShowConsentModal(true);
        return;
      }
      patchState({ isRecording: true });
    } else {
      const nextConsent = state.meetingConsent === 'allowed_once' ? 'prompt' : state.meetingConsent;
      patchState({ isRecording: false, meetingConsent: nextConsent });
    }
  };

  const handleConsent = (decision: 'allowed_once' | 'always_allowed' | 'denied') => {
    setShowConsentModal(false);
    if (decision === 'denied') {
      patchState({ meetingConsent: 'denied', isRecording: false });
    } else {
      patchState({ meetingConsent: decision, isRecording: true });
    }
  };

  const toggleStealth = () => {
    const next = !state.isStealthMode;
    patchState({ isStealthMode: next });
    window.desktopBridge?.toggleStealthMode(next);
  };

  const toggleChat = () => {
    patchState({ showChat: !state.showChat });
  };

  const openSettings = () => {
    window.desktopBridge?.openDashboard('settings');
  };

  const handleMinimize = () => {
    if (window.desktopBridge?.minimizeApp) {
      window.desktopBridge.minimizeApp();
    }
  };

  const handleClose = () => {
    if (window.desktopBridge?.quitApp) {
      window.desktopBridge.quitApp();
    }
  };

  const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    patchState({ activeMode: e.target.value as AssistantMode });
  };

  return (
    <div className="flex items-center justify-between w-full h-[54px] px-3 bg-slate-900/95 backdrop-blur-xl border border-slate-700/80 rounded-full shadow-2xl text-slate-200 select-none overflow-hidden box-border">
      {showConsentModal ? (
        <div className="flex items-center justify-between w-full h-full px-1 text-xs animate-in fade-in">
          <div className="flex items-center gap-1.5 text-cyan-300 font-medium truncate">
            <Shield className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
            <span className="truncate">Enable meeting transcription?</span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => handleConsent('denied')}
              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-[11px] font-medium"
            >
              Deny
            </button>
            <button
              onClick={() => handleConsent('allowed_once')}
              className="px-2 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded-md text-[11px] font-medium"
            >
              Allow Once
            </button>
            <button
              onClick={() => handleConsent('always_allowed')}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-[11px] font-medium"
            >
              Always Allow
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Drag Handle */}
          <div
            className="drag-region flex items-center pr-1.5 cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-300 flex-shrink-0"
            title="Drag to move assistant"
          >
            <GripHorizontal className="w-4 h-4" />
          </div>

          {/* Mic Status & Toggle (Permission Transparency) */}
          <button
            onClick={toggleRecording}
            className={`no-drag relative flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all flex-shrink-0 whitespace-nowrap ${
              state.isRecording
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title={state.isRecording ? '🎙 Audio Recording Active (Click to Stop)' : 'Start Listening (Mic + Meeting Audio)'}
          >
            {state.isRecording ? (
              <>
                <span
                  className={`w-2 h-2 rounded-full ${
                    state.meHasVoiceActivity
                      ? 'bg-rose-500 animate-ping'
                      : 'bg-rose-500 animate-pulse'
                  }`}
                />
                <Mic className="w-3.5 h-3.5" />
                <span>🎙 Audio Recording Active</span>
              </>
            ) : (
              <>
                <MicOff className="w-3.5 h-3.5" />
                <span>Idle</span>
              </>
            )}
          </button>

          {/* Local Privacy Mode Badge */}
          {state.privacyMode === 'local' && (
            <span
              className="no-drag flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-medium"
              title="Local Privacy Mode Active: Zero cloud data transmission"
            >
              🛡️ Local
            </span>
          )}

          {/* Mode Selector */}
          <div className="no-drag flex items-center px-1.5 flex-shrink-0">
            <select
              value={state.activeMode}
              onChange={handleModeChange}
              className="bg-slate-800/90 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500 cursor-pointer"
            >
              <option value="copilot">Copilot</option>
              <option value="interview">Interview</option>
              <option value="coding">Coding</option>
              <option value="sales">Sales</option>
              <option value="executive">Executive</option>
            </select>
          </div>

          {/* Screen Context & Quick Ask */}
          <button
            onClick={onAsk}
            disabled={isGenerating}
            className="no-drag flex items-center gap-1.5 px-3 py-1 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-xs font-semibold shadow-md active:scale-95 transition-all disabled:opacity-50 flex-shrink-0 whitespace-nowrap"
            title={isGenerating ? '🖥 Screen Monitoring Active' : 'Capture Screen & Ask AI (Ctrl+Enter)'}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span className="whitespace-nowrap">{isGenerating ? '🖥 Screen Active' : 'Ask AI'}</span>
          </button>

          {/* Feature Controls: Stealth, Settings, Expand */}
          <div className="no-drag flex items-center gap-0.5 pl-1.5 border-l border-slate-700/60 text-slate-400 flex-shrink-0">
            {/* Stealth Anti-Capture Toggle */}
            <button
              onClick={toggleStealth}
              className={`p-1.5 rounded-full hover:bg-slate-800 transition-colors ${
                state.isStealthMode ? 'text-emerald-400' : 'text-slate-500'
              }`}
              title={
                state.isStealthMode
                  ? 'Stealth Active: Window is hidden from Zoom / Teams / Meet screen-share'
                  : 'Stealth Inactive: Window is visible to screen capture'
              }
            >
              {state.isStealthMode ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
            </button>

            {/* Dashboard / Settings */}
            <button
              onClick={openSettings}
              className="p-1.5 rounded-full hover:bg-slate-800 hover:text-slate-200 transition-colors"
              title="Open Settings & Knowledge Base"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* Chat Toggle */}
            <button
              onClick={toggleChat}
              className="p-1.5 rounded-full hover:bg-slate-800 hover:text-slate-200 transition-colors"
              title={state.showChat ? 'Hide Chat Card' : 'Show Chat Card'}
            >
              {state.showChat ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {/* Window Controls: Minimize & Close Application */}
          <div className="no-drag flex items-center gap-0.5 pl-1.5 border-l border-slate-700/60 text-slate-400 flex-shrink-0">
            <button
              onClick={handleMinimize}
              className="p-1.5 rounded-full hover:bg-slate-800 hover:text-slate-100 transition-colors"
              title="Minimize to Taskbar"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleClose}
              className="p-1.5 rounded-full hover:bg-rose-500/20 hover:text-rose-400 transition-colors"
              title="Close Cluely Copilot"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
};

