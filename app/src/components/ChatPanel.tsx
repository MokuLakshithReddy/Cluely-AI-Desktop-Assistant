import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Square,
  Sparkles,
  Camera,
  Copy,
  Check,
  Radio,
  MessageSquare,
  BookOpen,
} from 'lucide-react';
import { SharedState, ChatMessage } from '../lib/types';
import { StateUpdater } from '../hooks/useSharedState';
import { TranscriptLive } from './TranscriptLive';

interface ChatPanelProps {
  state: SharedState;
  patchState: (updater: StateUpdater) => Promise<SharedState>;
  onAsk: (query: string, captureScreen: boolean) => Promise<void>;
  onStop: () => void;
  isGenerating: boolean;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  state,
  patchState,
  onAsk,
  onStop,
  isGenerating,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'transcript'>('chat');
  const [queryInput, setQueryInput] = useState('');
  const [includeScreen, setIncludeScreen] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messages = state.session?.messages || [];
  const transcript = state.session?.transcript || [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!queryInput.trim() && !includeScreen) return;
    const q = queryInput.trim();
    setQueryInput('');
    onAsk(q, includeScreen);
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex flex-col w-full h-full bg-slate-900/95 backdrop-blur-xl border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100 select-none">
      {/* Header Tabs */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-950/80 border-b border-slate-800">
        <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
              activeTab === 'chat'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>AI Copilot</span>
          </button>
          <button
            onClick={() => setActiveTab('transcript')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
              activeTab === 'transcript'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Transcript ({transcript.length})</span>
          </button>
        </div>

        {/* Mode & Model Indicators */}
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold bg-cyan-950 text-cyan-300 border border-cyan-800/60">
            {state.activeMode}
          </span>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-hidden relative">
        {activeTab === 'transcript' ? (
          <TranscriptLive
            transcript={transcript}
            meHasVoiceActivity={state.meHasVoiceActivity}
            themHasVoiceActivity={state.themHasVoiceActivity}
          />
        ) : (
          <div className="flex flex-col h-full overflow-y-auto p-3 space-y-3 select-text">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2 text-center py-12">
                <Sparkles className="w-8 h-8 text-cyan-400/80 animate-pulse" />
                <h4 className="font-semibold text-slate-300 text-sm">Ready to assist</h4>
                <p className="text-xs max-w-[280px]">
                  Press <kbd className="px-1.5 py-0.5 bg-slate-800 rounded border border-slate-700 text-slate-300 font-mono text-[10px]">Ctrl+Enter</kbd> or click Ask AI to interpret the active screen & conversation.
                </p>
              </div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.id}
                  className={`flex flex-col space-y-1.5 p-3 rounded-xl border text-xs leading-relaxed transition-all ${
                    msg.role === 'user'
                      ? 'bg-slate-800/50 border-slate-700 ml-6 text-slate-200'
                      : 'bg-slate-900/80 border-cyan-950 mr-2 text-slate-100 shadow-sm'
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span className="font-semibold uppercase tracking-wider text-cyan-400">
                      {msg.role === 'user' ? 'You' : 'Cluely Copilot'}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-500">
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {msg.role === 'assistant' && (
                        <button
                          onClick={() => copyToClipboard(msg.content, msg.id)}
                          className="hover:text-cyan-300 transition-colors"
                          title="Copy Answer"
                        >
                          {copiedId === msg.id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Screenshot Thumbnail Preview if user attached one */}
                  {msg.screenshot && (
                    <div className="my-1.5">
                      <img
                        src={`data:image/png;base64,${msg.screenshot}`}
                        alt="Captured Screen Context"
                        className="max-h-32 rounded-lg border border-slate-700 object-cover shadow-sm"
                      />
                    </div>
                  )}

                  {/* Message Content */}
                  <div className="whitespace-pre-wrap font-sans text-slate-200">
                    {msg.content || (msg.isStreaming ? 'Thinking...' : '')}
                  </div>

                  {/* Retrieved Sources Attribution */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-800 text-[10px] text-slate-400 space-y-1">
                      <span className="flex items-center gap-1 font-semibold text-slate-300">
                        <BookOpen className="w-3 h-3 text-cyan-400" /> Grounded in Knowledge:
                      </span>
                      {msg.sources.map((s, idx) => (
                        <div key={idx} className="truncate pl-3 border-l border-slate-700 italic">
                          {s}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Form Bar */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 p-2.5 bg-slate-950/90 border-t border-slate-800"
      >
        {/* Toggle Include Screen in prompt */}
        <button
          type="button"
          onClick={() => setIncludeScreen(!includeScreen)}
          className={`p-2 rounded-lg border transition-all ${
            includeScreen
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-sm'
              : 'bg-slate-800/60 text-slate-500 border-slate-700'
          }`}
          title={includeScreen ? 'Screen capture attached to question' : 'Text only (no screenshot)'}
        >
          <Camera className="w-4 h-4" />
        </button>

        {/* Text Input */}
        <input
          type="text"
          value={queryInput}
          onChange={e => setQueryInput(e.target.value)}
          placeholder={
            includeScreen
              ? 'Ask question about this screen & conversation...'
              : 'Ask question...'
          }
          className="flex-1 bg-slate-900 border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
        />

        {/* Submit or Stop Button */}
        {isGenerating ? (
          <button
            type="button"
            onClick={onStop}
            className="p-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 transition-colors"
            title="Stop Generation"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            className="p-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-all shadow-md active:scale-95"
            title="Send (Enter)"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </form>
    </div>
  );
};

