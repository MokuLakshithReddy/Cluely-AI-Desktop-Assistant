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
} from 'lucide-react';
import { SharedState, AssistantMode } from '../lib/types';

interface FloatingBarProps {
  state: SharedState;
  patchState: (patch: Partial<SharedState>) => Promise<void>;
  onAsk: () => void;
  isGenerating?: boolean;
}

export const FloatingBar: React.FC<FloatingBarProps> = ({
  state,
  patchState,
  onAsk,
  isGenerating,
}) => {
  const toggleRecording = () => {
    patchState({ isRecording: !state.isRecording });
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

  const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    patchState({ activeMode: e.target.value as AssistantMode });
  };

  return (
    <div className="flex items-center justify-between w-full h-[52px] px-3 bg-slate-900/90 backdrop-blur-md border border-slate-700/60 rounded-full shadow-2xl text-slate-200 select-none">
      {/* Drag Handle */}
      <div className="drag-region flex items-center pr-2 cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-300">
        <GripHorizontal className="w-4 h-4" />
      </div>

      {/* Mic Status & Toggle */}
      <button
        onClick={toggleRecording}
        className={`no-drag relative flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
          state.isRecording
            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
        }`}
        title={state.isRecording ? 'Listening (Click to Stop)' : 'Start Listening (Mic + Audio)'}
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
            <span>Listening</span>
          </>
        ) : (
          <>
            <MicOff className="w-3.5 h-3.5" />
            <span>Idle</span>
          </>
        )}
      </button>

      {/* Mode Selector */}
      <div className="no-drag flex items-center px-2">
        <select
          value={state.activeMode}
          onChange={handleModeChange}
          className="bg-slate-800/80 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500 cursor-pointer"
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
        className="no-drag flex items-center gap-1.5 px-3 py-1 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-xs font-semibold shadow-md active:scale-95 transition-all disabled:opacity-50"
        title="Capture Screen & Ask AI (Ctrl+Enter)"
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>{isGenerating ? 'Thinking...' : 'Ask AI'}</span>
      </button>

      {/* Controls: Stealth, Settings, Expand */}
      <div className="no-drag flex items-center gap-1 pl-2 border-l border-slate-700/60 text-slate-400">
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
    </div>
  );
};

