import React, { useState, useEffect } from 'react';
import {
  Key,
  Keyboard,
  BookOpen,
  History,
  Trash2,
  Plus,
  Upload,
  Download,
  Check,
  ShieldCheck,
  AlertCircle,
  FileText,
  FileCode,
  FileUp,
  Eye,
  ArrowLeft,
  Monitor,
  Cpu,
} from 'lucide-react';
import { SharedState, KnowledgeDoc, SessionSummary, SessionRecord } from '../lib/types';
import { StateUpdater } from '../hooks/useSharedState';
import { createKnowledgeDoc, parseDocumentFile } from '../lib/knowledge';

interface DashboardProps {
  state: SharedState;
  patchState: (updater: StateUpdater) => Promise<SharedState>;
  initialTab?: 'models' | 'knowledge' | 'shortcuts' | 'history' | 'desktop';
}

export const Dashboard: React.FC<DashboardProps> = ({ state, patchState, initialTab }) => {
  const [activeTab, setActiveTab] = useState<'models' | 'knowledge' | 'shortcuts' | 'history' | 'desktop'>(
    initialTab || 'models'
  );

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onDashboardSwitchTab?.(tab => {
      if (tab === 'models' || tab === 'knowledge' || tab === 'shortcuts' || tab === 'history' || tab === 'desktop') {
        setActiveTab(tab);
      }
    });

    const handleCustomEvent = (e: any) => {
      const tab = e.detail;
      if (tab === 'models' || tab === 'knowledge' || tab === 'shortcuts' || tab === 'history' || tab === 'desktop') {
        setActiveTab(tab);
      }
    };
    window.addEventListener('cluely-dashboard-tab', handleCustomEvent as EventListener);

    return () => {
      unsubscribe?.();
      window.removeEventListener('cluely-dashboard-tab', handleCustomEvent as EventListener);
    };
  }, []);

  const isWeb = Boolean(window.desktopBridge?.isWebMode);

  // Vault Key Inputs
  const [geminiInput, setGeminiInput] = useState('');
  const [openaiInput, setOpenaiInput] = useState('');
  const [anthropicInput, setAnthropicInput] = useState('');
  const [groqInput, setGroqInput] = useState('');
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);

  // Knowledge & File Upload State
  const [newDocTitle, setNewDocTitle] = useState('');
  const [newDocContent, setNewDocContent] = useState('');
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Session History State
  const [pastSessions, setPastSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionRecord | null>(null);

  useEffect(() => {
    loadSessions();
  }, [activeTab]);

  const loadSessions = async () => {
    if (window.desktopBridge?.listPastSessions) {
      try {
        const list = await window.desktopBridge.listPastSessions();
        setPastSessions(list);
      } catch (e) {
        console.warn('Failed to load sessions:', e);
      }
    }
  };

  const handleSaveKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.desktopBridge) return;
    setVaultError(null);

    try {
      if (geminiInput.trim()) await window.desktopBridge.saveApiKey('gemini', geminiInput.trim());
      if (openaiInput.trim()) await window.desktopBridge.saveApiKey('openai', openaiInput.trim());
      if (anthropicInput.trim()) await window.desktopBridge.saveApiKey('anthropic', anthropicInput.trim());
      if (groqInput.trim()) await window.desktopBridge.saveApiKey('groq', groqInput.trim());

      // Clear input fields so keys are not kept in component state memory
      setGeminiInput('');
      setOpenaiInput('');
      setAnthropicInput('');
      setGroqInput('');

      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2500);
    } catch (err: any) {
      console.error('[Dashboard] Error persisting credentials to vault:', err);
      setVaultError(err.message || 'Failed to save credentials in vault');
    }
  };

  const handleDeleteKey = async (provider: string) => {
    if (window.desktopBridge?.deleteApiKey) {
      await window.desktopBridge.deleteApiKey(provider);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsProcessingFile(true);
    setFileError(null);

    try {
      const newDocs: KnowledgeDoc[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const parsed = await parseDocumentFile(file);
        const doc = createKnowledgeDoc(parsed.title, parsed.content, 'file', file.name);
        newDocs.push(doc);
      }

      await patchState(prev => ({
        knowledgeDocs: [...(prev.knowledgeDocs || []), ...newDocs],
      }));
    } catch (err: any) {
      setFileError(err.message || 'Failed to process document file');
    } finally {
      setIsProcessingFile(false);
      e.target.value = '';
    }
  };

  const handleAddManualKnowledge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocTitle.trim() || !newDocContent.trim()) return;

    const doc = createKnowledgeDoc(newDocTitle.trim(), newDocContent.trim(), 'pasted');
    await patchState(prev => ({
      knowledgeDocs: [...(prev.knowledgeDocs || []), doc],
    }));

    setNewDocTitle('');
    setNewDocContent('');
  };

  const handleDeleteDoc = async (id: string) => {
    await patchState(prev => ({
      knowledgeDocs: (prev.knowledgeDocs || []).filter(d => d.id !== id),
    }));
  };

  const handleLoadSession = async (id: string) => {
    if (window.desktopBridge?.getPastSession) {
      const sess = await window.desktopBridge.getPastSession(id);
      setSelectedSession(sess);
    }
  };

  const handleDeleteSession = async (id: string) => {
    if (confirm('Delete this saved session?')) {
      if (window.desktopBridge?.deletePastSession) {
        await window.desktopBridge.deletePastSession(id);
        await loadSessions();
        if (selectedSession?.id === id) setSelectedSession(null);
      }
    }
  };

  const handlePurgeAllSessions = async () => {
    if (confirm('Permanently purge all archived sessions, knowledge documents, and active transcripts?')) {
      if (window.desktopBridge?.purgeAllData) {
        await window.desktopBridge.purgeAllData();
      } else if (window.desktopBridge?.purgeAllPastSessions) {
        await window.desktopBridge.purgeAllPastSessions();
      }
      await loadSessions();
      await patchState({ session: null, knowledgeDocs: [] });
      setSelectedSession(null);
    }
  };

  const handleExportSession = (sess: SessionRecord | null) => {
    if (!sess) return;
    const jsonStr = JSON.stringify(sess, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${sess.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans select-none overflow-hidden">
      {/* Sidebar Navigation */}
      <div className="w-60 bg-slate-900 border-r border-slate-800 p-4 flex flex-col justify-between">
        <div className="space-y-6">
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center font-bold text-white shadow-md">
                C
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-100">Cluely Copilot</h2>
                <p className="text-[10px] text-slate-500">v{state.appVersion} • Web Verified</p>
              </div>
            </div>
          </div>

          <button
            onClick={() => { window.location.hash = ''; }}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 text-cyan-400 text-xs font-semibold border border-slate-700/60 shadow-sm transition-all"
            title="Return to Floating Copilot and Chat"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Copilot View</span>
          </button>

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
              <span>Models & Vault</span>
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
              <span>Session Archive ({pastSessions.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('desktop')}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'desktop'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Monitor className="w-4 h-4" />
              <span>Desktop App & Installers</span>
            </button>
          </nav>
        </div>

        {/* Security badge */}
        <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-[11px] text-slate-400 space-y-1">
          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
            <ShieldCheck className="w-4 h-4" /> {isWeb ? 'Ephemeral Memory' : 'Secure OS Vault'}
          </div>
          <p className="text-[10px] leading-tight text-slate-500">
            {isWeb
              ? 'Web Mode: API keys kept in ephemeral browser memory only. Never written to disk or localStorage.'
              : 'Keys encrypted via Windows DPAPI / macOS Keychain. Plaintext keys never touch renderer state.'}
          </p>
        </div>
      </div>

      {/* Main Tab Area */}
      <div className="flex-1 overflow-y-auto p-8 select-text">
        {activeTab === 'models' && (
          <div className="max-w-xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100">AI Model & Credential Vault</h3>
              <p className="text-xs text-slate-400 mt-1">
                {isWeb
                  ? 'Keys are held ephemerally in session memory and cleared on reload. Use the Desktop app for hardware-backed vault storage.'
                  : 'Keys are stored securely in your OS credential vault with header-based authorization.'}
              </p>
            </div>

            {isWeb && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
                <div>
                  <span className="font-semibold">Web Mode Active:</span> API keys are stored in ephemeral browser session memory only. They will not persist across browser restarts and are never written to disk or localStorage. Run the desktop application for OS-level DPAPI / Keychain encryption.
                </div>
              </div>
            )}

            {vaultError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs text-rose-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{vaultError}</span>
              </div>
            )}

            <form onSubmit={handleSaveKeys} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Active Reasoning Model
                </label>
                <select
                  value={state.activeModel}
                  onChange={e => patchState({ activeModel: e.target.value as any })}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:ring-1 focus:ring-cyan-500"
                >
                  <option value="gemini-2.5-flash">Google Gemini 2.5 Flash (Recommended - Sub-second Latency)</option>
                  <option value="gemini-2.5-pro">Google Gemini 2.5 Pro (Deep Multimodal Reasoning)</option>
                  <option value="gpt-4o">OpenAI GPT-4o (Multimodal Vision)</option>
                  <option value="gpt-4o-mini">OpenAI GPT-4o Mini (Fast & Efficient)</option>
                  <option value="claude-3-7-sonnet">Anthropic Claude 3.7 Sonnet (Hybrid Reasoning)</option>
                  <option value="claude-3-5-haiku">Anthropic Claude 3.5 Haiku (Ultra-Fast Coding)</option>
                  <option value="ollama">Local Ollama (Offline - localhost:11434)</option>
                </select>
              </div>

              {/* Gemini Key */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-300">Google Gemini API Key</label>
                  {state.hasApiKeys.gemini ? (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                      <Check className="w-3 h-3" /> Stored in Vault
                      <button
                        type="button"
                        onClick={() => handleDeleteKey('gemini')}
                        className="ml-2 text-slate-500 hover:text-rose-400"
                      >
                        Delete
                      </button>
                    </span>
                  ) : (
                    <span className="text-[10px] text-amber-400">Not Configured</span>
                  )}
                </div>
                <input
                  type="password"
                  value={geminiInput}
                  onChange={e => setGeminiInput(e.target.value)}
                  placeholder={state.hasApiKeys.gemini ? '••••••••••••••••••••••••' : 'AIzaSy...'}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              {/* OpenAI Key */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-300">OpenAI API Key</label>
                  {state.hasApiKeys.openai ? (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                      <Check className="w-3 h-3" /> Stored in Vault
                      <button
                        type="button"
                        onClick={() => handleDeleteKey('openai')}
                        className="ml-2 text-slate-500 hover:text-rose-400"
                      >
                        Delete
                      </button>
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500">Optional</span>
                  )}
                </div>
                <input
                  type="password"
                  value={openaiInput}
                  onChange={e => setOpenaiInput(e.target.value)}
                  placeholder={state.hasApiKeys.openai ? '••••••••••••••••••••••••' : 'sk-proj-...'}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              {/* Anthropic Claude Key */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-300">Anthropic Claude API Key</label>
                  {state.hasApiKeys.anthropic ? (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                      <Check className="w-3 h-3" /> Stored in Vault
                      <button
                        type="button"
                        onClick={() => handleDeleteKey('anthropic')}
                        className="ml-2 text-slate-500 hover:text-rose-400"
                      >
                        Delete
                      </button>
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500">Optional</span>
                  )}
                </div>
                <input
                  type="password"
                  value={anthropicInput}
                  onChange={e => setAnthropicInput(e.target.value)}
                  placeholder={state.hasApiKeys.anthropic ? '••••••••••••••••••••••••' : 'sk-ant-...'}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              {/* Groq Key for Whisper */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-300">
                    Groq API Key (Whisper &lt;300ms Live STT)
                  </label>
                  {state.hasApiKeys.groq ? (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                      <Check className="w-3 h-3" /> Stored in Vault
                      <button
                        type="button"
                        onClick={() => handleDeleteKey('groq')}
                        className="ml-2 text-slate-500 hover:text-rose-400"
                      >
                        Delete
                      </button>
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500">Optional (Recommended for fast speech)</span>
                  )}
                </div>
                <input
                  type="password"
                  value={groqInput}
                  onChange={e => setGroqInput(e.target.value)}
                  placeholder={state.hasApiKeys.groq ? '••••••••••••••••••••••••' : 'gsk_...'}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-md transition-all flex items-center gap-2"
                >
                  {savedSuccess ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-300" />
                      <span>Encrypted & Saved to Vault!</span>
                    </>
                  ) : (
                    <span>Update Encrypted Credentials</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {activeTab === 'knowledge' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100">Personal Knowledge & Document Ingestion</h3>
              <p className="text-xs text-slate-400 mt-1">
                Upload PDFs, Markdown documents, source code, or paste meeting notes. The AI automatically retrieves matching passages during live queries.
              </p>
            </div>

            {/* File Upload Zone */}
            <div className="p-5 bg-slate-900 border-2 border-dashed border-slate-700/80 rounded-xl flex flex-col items-center justify-center space-y-2 hover:border-cyan-500/60 transition-colors">
              <FileUp className="w-8 h-8 text-cyan-400/80" />
              <div className="text-center">
                <p className="text-xs font-semibold text-slate-200">
                  Upload PDF, Markdown, Text, or Code Files
                </p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  Supports .pdf, .md, .txt, .json, .py, .ts, .js
                </p>
              </div>
              <label className="cursor-pointer px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium border border-slate-700 shadow-sm transition-all">
                <span>{isProcessingFile ? 'Parsing...' : 'Select Documents'}</span>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.md,.txt,.json,.py,.ts,.js,.csv"
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={isProcessingFile}
                />
              </label>
              {fileError && <p className="text-xs text-rose-400">{fileError}</p>}
            </div>

            {/* Manual Paste Form */}
            <form onSubmit={handleAddManualKnowledge} className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
              <h4 className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-cyan-400" /> Or Paste Note / Context
              </h4>
              <input
                type="text"
                value={newDocTitle}
                onChange={e => setNewDocTitle(e.target.value)}
                placeholder="Title (e.g. System Design Cheat Sheet, Resume Notes)"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:ring-1 focus:ring-cyan-500"
              />
              <textarea
                value={newDocContent}
                onChange={e => setNewDocContent(e.target.value)}
                placeholder="Paste Markdown, text, or interview notes..."
                rows={4}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-200 focus:ring-1 focus:ring-cyan-500 font-mono"
              />
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow transition-all"
              >
                Chunk & Index Note
              </button>
            </form>

            {/* Indexed Document List */}
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
                    <div className="flex items-center gap-3">
                      {doc.sourceType === 'file' ? (
                        <FileCode className="w-5 h-5 text-cyan-400" />
                      ) : (
                        <FileText className="w-5 h-5 text-indigo-400" />
                      )}
                      <div>
                        <h5 className="text-xs font-bold text-slate-200">{doc.title}</h5>
                        <p className="text-[10px] text-slate-500">
                          {doc.chunks.length} passages • {doc.sourceType === 'file' ? `File: ${doc.fileName}` : 'Pasted Note'}
                        </p>
                      </div>
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
                These hotkeys function globally across your operating system even when other windows are focused.
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
          <div className="max-w-2xl space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-100">Session History Archive</h3>
                <p className="text-xs text-slate-400 mt-1">
                  Past meetings, coding sessions, and interviews persisted in your local session repository.
                </p>
              </div>
              <button
                onClick={handlePurgeAllSessions}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-600/40 text-xs font-medium transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" /> Purge All History
              </button>
            </div>

            {/* Past Sessions List */}
            <div className="space-y-2.5">
              {pastSessions.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No archived sessions found.</p>
              ) : (
                pastSessions.map(s => (
                  <div
                    key={s.id}
                    className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex items-center justify-between hover:border-slate-700 transition-colors"
                  >
                    <div>
                      <h4 className="text-xs font-bold text-slate-200">{s.title}</h4>
                      <p className="text-[10px] text-slate-500">
                        {new Date(s.createdAt).toLocaleString()} • Mode: <span className="text-cyan-400 uppercase">{s.mode}</span> • {s.transcriptCount} speech lines • {s.messageCount} AI queries
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleLoadSession(s.id)}
                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs transition-colors flex items-center gap-1"
                      >
                        <Eye className="w-3.5 h-3.5" /> View
                      </button>
                      <button
                        onClick={() => handleDeleteSession(s.id)}
                        className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                        title="Delete Session"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Session Detail Modal / View */}
            {selectedSession && (
              <div className="p-4 bg-slate-900 border border-cyan-800/80 rounded-xl space-y-3 mt-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div>
                    <h4 className="text-xs font-bold text-cyan-300">{selectedSession.title}</h4>
                    <p className="text-[10px] text-slate-400">ID: {selectedSession.id}</p>
                  </div>
                  <button
                    onClick={() => handleExportSession(selectedSession)}
                    className="flex items-center gap-1 px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs"
                  >
                    <Download className="w-3.5 h-3.5" /> Export JSON
                  </button>
                </div>

                <div className="max-h-60 overflow-y-auto space-y-2 text-xs">
                  <h5 className="font-semibold text-slate-300">Transcript ({selectedSession.transcript.length}):</h5>
                  {selectedSession.transcript.map(t => (
                    <div key={t.id} className="text-[11px] text-slate-300 pl-2 border-l border-slate-700">
                      <strong className={t.role === 'me' ? 'text-emerald-400' : 'text-purple-400'}>
                        {t.role === 'me' ? 'You' : 'Remote'}:
                      </strong> {t.text}
                    </div>
                  ))}

                  <h5 className="font-semibold text-slate-300 pt-2">AI Interactions ({selectedSession.messages.length}):</h5>
                  {selectedSession.messages.map(m => (
                    <div key={m.id} className="text-[11px] text-slate-300 pl-2 border-l border-cyan-700">
                      <strong>{m.role === 'user' ? 'You' : 'Copilot'}:</strong> {m.content.slice(0, 150)}...
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'desktop' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Monitor className="w-5 h-5 text-cyan-400" /> Cluely Copilot Desktop Application
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Cluely Copilot is designed as an independent native desktop AI assistant with advanced capabilities. Anyone can download, build, and run this application on Windows, macOS, or Linux.
              </p>
            </div>

            {/* Key Desktop Features */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-1.5">
                <div className="flex items-center gap-2 text-cyan-400 font-semibold text-xs">
                  <ShieldCheck className="w-4 h-4" /> Secure OS Vault
                </div>
                <p className="text-[11px] text-slate-400">
                  Encrypted credentials stored securely via OS keychains (DPAPI / Keychain).
                </p>
              </div>

              <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-1.5">
                <div className="flex items-center gap-2 text-indigo-400 font-semibold text-xs">
                  <Cpu className="w-4 h-4" /> Dual Audio VAD & Loopback
                </div>
                <p className="text-[11px] text-slate-400">
                  Real-time microphone & system loopback audio capture with Whisper STT.
                </p>
              </div>
            </div>

            {/* Packaging & Distribution Instructions */}
            <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                How to Build & Package for Distribution
              </h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                To build standalone installable packages (<code className="text-cyan-300">.exe</code>, <code className="text-cyan-300">.dmg</code>, <code className="text-cyan-300">AppImage</code>) for anyone to install on their desktop, run the following commands in your terminal:
              </p>

              <div className="space-y-2 font-mono text-xs">
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-slate-300">
                  <span className="text-cyan-400"># 1. Install dependencies</span><br />
                  npm install
                </div>
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-slate-300">
                  <span className="text-cyan-400"># 2. Build Vite frontend & Electron TypeScript compiler</span><br />
                  npm run build
                </div>
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-slate-300">
                  <span className="text-cyan-400"># 3. Package native desktop app (creates release folder)</span><br />
                  npm run pack
                </div>
              </div>

              <p className="text-[11px] text-slate-500">
                The resulting installer or portable binary will be saved in the <code className="text-slate-300">release/</code> directory ready for sharing and distribution.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
