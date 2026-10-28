import React, { useState } from 'react';
import {
  Key,
  Keyboard,
  BookOpen,
  History,
  Trash2,
  Plus,
  Download,
  Check,
  ShieldCheck,
  AlertCircle,
} from 'lucide-react';
import { SharedState, KnowledgeDoc } from '../lib/types';
import { chunkDocument } from '../lib/knowledge';

interface DashboardProps {
  state: SharedState;
  patchState: (patch: Partial<SharedState>) => Promise<void>;
}

export const Dashboard: React.FC<DashboardProps> = ({ state, patchState }) => {
  const [activeTab, setActiveTab] = useState<'models' | 'knowledge' | 'shortcuts' | 'history'>(
    'models'
  );

  // Model & Key state
  const [geminiKey, setGeminiKey] = useState(state.apiKeys?.gemini || '');
  const [openaiKey, setOpenaiKey] = useState(state.apiKeys?.openai || '');
  const [groqKey, setGroqKey] = useState(state.apiKeys?.groq || '');
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Knowledge state
  const [newDocTitle, setNewDocTitle] = useState('');
  const [newDocContent, setNewDocContent] = useState('');

  const saveApiKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    await patchState({
      apiKeys: {
        ...state.apiKeys,
        gemini: geminiKey.trim(),
        openai: openaiKey.trim(),
        groq: groqKey.trim(),
      },
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const handleAddKnowledge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocTitle.trim() || !newDocContent.trim()) return;

    const chunks = chunkDocument(newDocContent);
    const newDoc: KnowledgeDoc = {
      id: `doc_${Date.now()}`,
      title: newDocTitle.trim(),
      content: newDocContent.trim(),
      chunks,
      addedAt: new Date().toISOString(),
    };

    const updated = [...(state.knowledgeDocs || []), newDoc];
    await patchState({ knowledgeDocs: updated });
    setNewDocTitle('');
    setNewDocContent('');
  };

  const handleDeleteDoc = async (id: string) => {
    const updated = (state.knowledgeDocs || []).filter(d => d.id !== id);
    await patchState({ knowledgeDocs: updated });
  };

  const handleExportSession = () => {
    if (!state.session) return;
    const jsonStr = JSON.stringify(state.session, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cluely-session-${state.session.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePurgeAllData = async () => {
    if (confirm('Are you sure you want to purge all session transcripts and knowledge documents?')) {
      await patchState({
        session: null,
        knowledgeDocs: [],
      });
    }
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans select-none overflow-hidden">
      {/* Sidebar Navigation */}
      <div className="w-56 bg-slate-900 border-r border-slate-800 p-4 flex flex-col justify-between">
        <div className="space-y-6">
          <div className="flex items-center gap-2 px-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center font-bold text-white shadow-md">
              C
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Cluely Copilot</h2>
              <p className="text-[10px] text-slate-500">v{state.appVersion} • Verified</p>
            </div>
          </div>

          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab('models')}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'models'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Key className="w-4 h-4" />
              <span>Models & Keys</span>
            </button>

            <button
              onClick={() => setActiveTab('knowledge')}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'knowledge'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span>Knowledge Base ({state.knowledgeDocs?.length || 0})</span>
            </button>

            <button
              onClick={() => setActiveTab('shortcuts')}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'shortcuts'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Keyboard className="w-4 h-4" />
              <span>Shortcuts</span>
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'history'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <History className="w-4 h-4" />
              <span>Session History</span>
            </button>
          </nav>
        </div>

        {/* Security badge */}
        <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-[11px] text-slate-400 space-y-1">
          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
            <ShieldCheck className="w-4 h-4" /> Secure BYOK
          </div>
          <p className="text-[10px] leading-tight text-slate-500">
            All API keys & documents stored locally in encrypted storage.
          </p>
        </div>
      </div>

      {/* Main Tab Area */}
      <div className="flex-1 overflow-y-auto p-8 select-text">
        {activeTab === 'models' && (
          <div className="max-w-xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100">AI Model Configuration</h3>
              <p className="text-xs text-slate-400 mt-1">
                Configure your API keys for multimodal vision, reasoning, and real-time speech-to-text.
              </p>
            </div>

            <form onSubmit={saveApiKeys} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Active Reasoning Model
                </label>
                <select
                  value={state.activeModel}
                  onChange={e => patchState({ activeModel: e.target.value as any })}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:ring-1 focus:ring-cyan-500"
                >
                  <option value="gemini-2.5-flash">Google Gemini 2.0 Flash (Recommended - Multimodal & Fast)</option>
                  <option value="gpt-4o">OpenAI GPT-4o (Multimodal Vision)</option>
                  <option value="claude-3-5-sonnet">Anthropic Claude 3.5 Sonnet</option>
                  <option value="ollama">Local Ollama (Offline)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Google Gemini API Key
                </label>
                <input
                  type="password"
                  value={geminiKey}
                  onChange={e => setGeminiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  OpenAI API Key
                </label>
                <input
                  type="password"
                  value={openaiKey}
                  onChange={e => setOpenaiKey(e.target.value)}
                  placeholder="sk-proj-..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Groq API Key (Whisper Ultra-Fast STT)
                </label>
                <input
                  type="password"
                  value={groqKey}
                  onChange={e => setGroqKey(e.target.value)}
                  placeholder="gsk_..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-md transition-all flex items-center gap-2"
                >
                  {savedSuccess ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-300" />
                      <span>Settings Saved!</span>
                    </>
                  ) : (
                    <span>Save Credentials</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {activeTab === 'knowledge' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100">Personal Knowledge Base</h3>
              <p className="text-xs text-slate-400 mt-1">
                Import resume notes, code snippets, project documentation, or talking points. The AI automatically retrieves relevant passages during conversations.
              </p>
            </div>

            <form onSubmit={handleAddKnowledge} className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
              <h4 className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-cyan-400" /> Add Document or Note
              </h4>
              <input
                type="text"
                value={newDocTitle}
                onChange={e => setNewDocTitle(e.target.value)}
                placeholder="Document Title (e.g., System Architecture, Resume Notes)"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:ring-1 focus:ring-cyan-500"
              />
              <textarea
                value={newDocContent}
                onChange={e => setNewDocContent(e.target.value)}
                placeholder="Paste Markdown, text, or documentation here..."
                rows={5}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-200 focus:ring-1 focus:ring-cyan-500 font-mono"
              />
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow transition-all"
              >
                Chunk & Index Document
              </button>
            </form>

            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                Indexed Documents ({state.knowledgeDocs?.length || 0})
              </h4>
              {(!state.knowledgeDocs || state.knowledgeDocs.length === 0) ? (
                <p className="text-xs text-slate-600 italic">No custom documents indexed yet.</p>
              ) : (
                state.knowledgeDocs.map(doc => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between p-3 bg-slate-900 border border-slate-800 rounded-xl"
                  >
                    <div>
                      <h5 className="text-xs font-bold text-slate-200">{doc.title}</h5>
                      <p className="text-[10px] text-slate-500">
                        {doc.chunks.length} indexed chunks • Added {new Date(doc.addedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      onClick={() => handleDeleteDoc(doc.id)}
                      className="p-1.5 text-slate-500 hover:text-rose-400 transition-colors"
                      title="Delete Document"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'shortcuts' && (
          <div className="max-w-xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100">Global Keyboard Shortcuts</h3>
              <p className="text-xs text-slate-400 mt-1">
                These hotkeys function globally across your system even when Cluely is not focused.
              </p>
            </div>

            <div className="space-y-3">
              {Object.entries(state.shortcuts || {}).map(([key, val]) => (
                <div
                  key={key}
                  className="flex items-center justify-between p-3 bg-slate-900 border border-slate-800 rounded-xl"
                >
                  <span className="text-xs font-medium text-slate-300 capitalize">
                    {key.replace(/([A-Z])/g, ' $1')}
                  </span>
                  <kbd className="px-2.5 py-1 bg-slate-950 border border-slate-700/80 rounded-md font-mono text-xs text-cyan-300 font-semibold shadow-inner">
                    {val}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="max-w-xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100">Session History & Retention</h3>
              <p className="text-xs text-slate-400 mt-1">
                Manage active session data, export transcripts, or execute privacy wipes.
              </p>
            </div>

            <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
              <h4 className="text-xs font-bold text-slate-200">Current Session</h4>
              {state.session ? (
                <div className="space-y-1 text-xs text-slate-400">
                  <p>Session ID: <span className="font-mono text-slate-200">{state.session.id}</span></p>
                  <p>Started: {new Date(state.session.createdAt).toLocaleString()}</p>
                  <p>Transcript Entries: <strong className="text-cyan-400">{state.session.transcript.length}</strong></p>
                  <p>AI Queries: <strong className="text-cyan-400">{state.session.messages.length / 2}</strong></p>
                </div>
              ) : (
                <p className="text-xs text-slate-500 italic">No active session.</p>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleExportSession}
                  disabled={!state.session}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors disabled:opacity-40"
                >
                  <Download className="w-3.5 h-3.5" /> Export Session (JSON)
                </button>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800">
              <button
                onClick={handlePurgeAllData}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-600/40 text-xs font-semibold transition-all"
              >
                <Trash2 className="w-4 h-4" /> Purge All Local Data & Wipe State
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

