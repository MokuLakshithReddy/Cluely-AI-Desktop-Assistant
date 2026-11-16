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
  Shield,
  Lock,
  EyeOff,
  Database,
  Radio,
  CreditCard,
  Sparkles,
  CheckCircle2,
  HardDrive,
  Gauge,
  Terminal,
} from 'lucide-react';
import { SharedState, KnowledgeDoc, SessionSummary, SessionRecord } from '../lib/types';
import { StateUpdater } from '../hooks/useSharedState';
import { createKnowledgeDoc, parseDocumentFile } from '../lib/knowledge';

type DashboardTab = 'models' | 'hardware' | 'subscription' | 'knowledge' | 'shortcuts' | 'history' | 'desktop' | 'security';

interface DashboardProps {
  state: SharedState;
  patchState: (updater: StateUpdater) => Promise<SharedState>;
  initialTab?: DashboardTab;
}

export const Dashboard: React.FC<DashboardProps> = ({ state, patchState, initialTab }) => {
  const [activeTab, setActiveTab] = useState<DashboardTab>(
    initialTab || 'models'
  );

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onDashboardSwitchTab?.((tab: any) => {
      setActiveTab(tab);
    });

    const handleCustomEvent = (e: any) => {
      const tab = e.detail;
      if (tab) setActiveTab(tab);
    };
    window.addEventListener('scandium-dashboard-tab', handleCustomEvent as EventListener);
    window.addEventListener('cluely-dashboard-tab', handleCustomEvent as EventListener);

    return () => {
      unsubscribe?.();
      window.removeEventListener('scandium-dashboard-tab', handleCustomEvent as EventListener);
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

  // Subscription & Licensing State
  const [licenseStatus, setLicenseStatus] = useState<any>(null);
  const [licenseInput, setLicenseInput] = useState('');
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [licenseMessage, setLicenseMessage] = useState<string | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);

  // Hardware & Local Models State
  const [hardwareProfile, setHardwareProfile] = useState<any>(null);
  const [ollamaStatus, setOllamaStatus] = useState<{ isRunning: boolean; version?: string; endpoint: string } | null>(null);
  const [installedOllamaModels, setInstalledOllamaModels] = useState<any[]>([]);
  const [catalogModels, setCatalogModels] = useState<any[]>([]);
  const [pullingModelName, setPullingModelName] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<string | null>(null);
  const [whisperModels, setWhisperModels] = useState<any[]>([]);
  const [downloadingWhisperId, setDownloadingWhisperId] = useState<string | null>(null);
  const [whisperProgress, setWhisperProgress] = useState<number>(0);
  const [testGenLoading, setTestGenLoading] = useState(false);
  const [testGenResult, setTestGenResult] = useState<{ success: boolean; text: string; latencyMs: number; error?: string } | null>(null);

  useEffect(() => {
    loadSessions();
    loadLicense();
    loadHardwareAndModels();
  }, [activeTab]);

  const loadLicense = async () => {
    if (window.desktopBridge?.getLicenseStatus) {
      try {
        const s = await window.desktopBridge.getLicenseStatus();
        setLicenseStatus(s);
        // Automatically validate license against Lemon Squeezy if currently cached
        if (s?.hasLicense && window.desktopBridge?.validateLicense) {
          window.desktopBridge.validateLicense().then((val: any) => {
            if (val) {
              window.desktopBridge?.getLicenseStatus?.().then((latest: any) => setLicenseStatus(latest));
            }
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('Failed to load license status:', e);
      }
    }
  };

  const loadHardwareAndModels = async () => {
    if (window.desktopBridge?.getHardwareProfile) {
      try {
        const hw = await window.desktopBridge.getHardwareProfile();
        setHardwareProfile(hw);
      } catch (e) {
        console.warn('Failed to load hardware:', e);
      }
    }
    if (window.desktopBridge?.getOllamaStatus) {
      try {
        const st = await window.desktopBridge.getOllamaStatus();
        setOllamaStatus(st);
      } catch (e) {
        console.warn('Failed to load Ollama status:', e);
      }
    }
    if (window.desktopBridge?.listOllamaModels) {
      try {
        const list = await window.desktopBridge.listOllamaModels();
        setInstalledOllamaModels(list);
      } catch (e) {
        console.warn('Failed to list Ollama models:', e);
      }
    }
    if (window.desktopBridge?.getOllamaCatalog) {
      try {
        const cat = await window.desktopBridge.getOllamaCatalog();
        setCatalogModels(cat);
      } catch (e) {
        console.warn('Failed to get catalog:', e);
      }
    }
    if (window.desktopBridge?.getWhisperModels) {
      try {
        const wModels = await window.desktopBridge.getWhisperModels();
        setWhisperModels(wModels);
      } catch (e) {
        console.warn('Failed to get whisper models:', e);
      }
    }
  };

  const handleActivateLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseInput.trim() || !window.desktopBridge?.activateLicense) return;
    setLicenseLoading(true);
    setLicenseError(null);
    setLicenseMessage(null);
    try {
      const rec = await window.desktopBridge.activateLicense(licenseInput.trim());
      setLicenseMessage(`License successfully activated! Tier: ${rec.tier.toUpperCase()}`);
      setLicenseInput('');
      await loadLicense();
    } catch (err: any) {
      setLicenseError(err?.message || 'Failed to activate license');
    } finally {
      setLicenseLoading(false);
    }
  };

  const handleDeactivateLicense = async () => {
    if (!window.desktopBridge?.deactivateLicense) return;
    if (!confirm('Are you sure you want to deactivate your license on this device?')) return;
    setLicenseLoading(true);
    setLicenseError(null);
    try {
      await window.desktopBridge.deactivateLicense();
      setLicenseMessage('License deactivated on this device.');
      await loadLicense();
    } catch (err: any) {
      setLicenseError(err?.message || 'Failed to deactivate license');
    } finally {
      setLicenseLoading(false);
    }
  };

  const handlePullModel = async (modelTag: string) => {
    if (!window.desktopBridge?.pullOllamaModel) return;
    setPullingModelName(modelTag);
    setPullProgress('Starting download...');
    try {
      await window.desktopBridge.pullOllamaModel(modelTag);
      setPullProgress('Download complete!');
      await loadHardwareAndModels();
    } catch (err: any) {
      alert(`Model download error: ${err?.message || String(err)}`);
    } finally {
      setPullingModelName(null);
      setPullProgress(null);
    }
  };

  const handleDeleteModel = async (modelTag: string) => {
    if (!window.desktopBridge?.deleteOllamaModel) return;
    if (!confirm(`Delete model ${modelTag} from local disk?`)) return;
    try {
      await window.desktopBridge.deleteOllamaModel(modelTag);
      await loadHardwareAndModels();
    } catch (err: any) {
      alert(`Failed to delete model: ${err?.message || String(err)}`);
    }
  };

  const handleTestOllama = async (modelTag?: string) => {
    if (!window.desktopBridge?.testOllamaGeneration) return;
    setTestGenLoading(true);
    setTestGenResult(null);
    try {
      const targetModel = modelTag || installedOllamaModels[0]?.name || 'llama3.2:1b';
      const res = await window.desktopBridge.testOllamaGeneration(targetModel);
      setTestGenResult(res);
    } catch (err: any) {
      setTestGenResult({ success: false, text: '', latencyMs: 0, error: err?.message || String(err) });
    } finally {
      setTestGenLoading(false);
    }
  };

  const handleDownloadWhisperModel = async (modelId: string) => {
    if (!window.desktopBridge?.downloadWhisperModel) return;
    setDownloadingWhisperId(modelId);
    setWhisperProgress(0);
    try {
      await window.desktopBridge.downloadWhisperModel(modelId);
      await loadHardwareAndModels();
    } catch (err: any) {
      alert(`Failed to download speech model: ${err?.message || String(err)}`);
    } finally {
      setDownloadingWhisperId(null);
    }
  };

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
    if (confirm('Permanently delete all archived sessions, knowledge documents, active session data, and saved API credentials? This removes the encrypted credential vault file from this app profile; it does not guarantee forensic erasure from storage media.')) {
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
                S
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-100">Scandium</h2>
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
              onClick={() => setActiveTab('subscription')}
              className={`flex items-center justify-between w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'subscription'
                  ? 'bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <CreditCard className="w-4 h-4 text-cyan-400" />
                <span>Subscription & License</span>
              </div>
              <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/60">
                {licenseStatus?.tier || 'Free'}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('hardware')}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'hardware'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Cpu className="w-4 h-4 text-indigo-400" />
              <span>Local AI & Hardware</span>
            </button>

            <button
              onClick={() => setActiveTab('models')}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'models'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Key className="w-4 h-4" />
              <span>Cloud BYOK Keys</span>
            </button>

            <button
              onClick={() => setActiveTab('security')}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                activeTab === 'security'
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Shield className="w-4 h-4" />
              <span>Privacy & Security</span>
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
            <ShieldCheck className="w-4 h-4" /> {isWeb ? 'Ephemeral Memory' : 'OS Credential Vault'}
          </div>
          <p className="text-[10px] leading-tight text-slate-500">
            {isWeb
              ? 'Web Mode: API keys kept in ephemeral browser memory only. Never written to disk or localStorage.'
              : 'Keys use an OS-backed credential store. On Linux, the insecure basic_text backend is rejected; configure Secret Service/libsecret or KWallet. Plaintext keys never enter renderer state.'}
          </p>
        </div>
      </div>

      {/* Main Tab Area */}
      <div className="flex-1 overflow-y-auto p-8 select-text">
        {state.persistenceError && (
          <div role="alert" className="mb-5 p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-300 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{state.persistenceError}</span>
          </div>
        )}

        {/* 1. Subscription & Licensing Pane */}
        {activeTab === 'subscription' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-cyan-400" /> Subscription & Device Licensing
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Scandium is a commercial desktop software licensed via monthly subscriptions. All local AI and transcription execute on your hardware without owner-hosted cloud fees.
              </p>
            </div>

            {/* Current Status Card */}
            <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Active Plan</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <h4 className="text-base font-bold text-slate-100">
                      {licenseStatus?.tier === 'pro' ? 'Scandium Pro' : licenseStatus?.tier === 'plus' ? 'Scandium Plus' : 'Scandium Free'}
                    </h4>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-semibold uppercase tracking-wider ${
                      licenseStatus?.status === 'active'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : licenseStatus?.status === 'grace_period'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'bg-slate-800 text-slate-400'
                    }`}>
                      {licenseStatus?.status === 'grace_period'
                        ? `Grace Period (${licenseStatus.graceRemainingDays} days left)`
                        : licenseStatus?.status || 'Active'}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Device Slots</span>
                  <p className="text-sm font-mono text-slate-200 mt-0.5">
                    {licenseStatus?.activationUsage || 1} / {licenseStatus?.activationLimit || (licenseStatus?.tier === 'pro' ? 5 : licenseStatus?.tier === 'plus' ? 2 : 1)}
                  </p>
                </div>
              </div>

              {licenseStatus?.licenseKeyMasked && (
                <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                  <span className="text-slate-400 font-mono">Key: {licenseStatus.licenseKeyMasked}</span>
                  {licenseStatus.expiresAt && (
                    <span className="text-slate-500 text-[11px]">Renewal: {new Date(licenseStatus.expiresAt).toLocaleDateString()}</span>
                  )}
                </div>
              )}

              <div className="pt-2 text-[11px] text-slate-400 flex items-center justify-between">
                <span>Machine ID: <code className="text-slate-300 font-mono">{licenseStatus?.instanceName || 'Scandium-Host'}</code></span>
                {licenseStatus?.hasLicense && (
                  <button
                    onClick={handleDeactivateLicense}
                    disabled={licenseLoading}
                    className="text-rose-400 hover:text-rose-300 underline font-medium"
                  >
                    Deactivate this Device
                  </button>
                )}
              </div>
            </div>

            {/* License Activation Form */}
            <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                Activate License Key
              </h4>
              <p className="text-xs text-slate-400">
                Purchased a subscription via Lemon Squeezy? Paste your license key below to activate premium entitlements on this machine.
              </p>

              <form onSubmit={handleActivateLicense} className="flex gap-2">
                <input
                  type="text"
                  placeholder="Paste Lemon Squeezy License Key..."
                  value={licenseInput}
                  onChange={e => setLicenseInput(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
                />
                <button
                  type="submit"
                  disabled={licenseLoading || !licenseInput.trim()}
                  className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white rounded-lg text-xs font-semibold shadow-md disabled:opacity-50 transition-all"
                >
                  {licenseLoading ? 'Validating...' : 'Activate'}
                </button>
              </form>

              {licenseMessage && (
                <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-xs text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>{licenseMessage}</span>
                </div>
              )}

              {licenseError && (
                <div className="p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs text-rose-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                  <span>{licenseError}</span>
                </div>
              )}
            </div>

            {/* Plan Comparison & Hosted Checkout */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                Available Subscription Plans
              </h4>

              <div className="grid grid-cols-3 gap-3">
                {/* Free Tier */}
                <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3 flex flex-col justify-between">
                  <div>
                    <h5 className="font-bold text-slate-100 text-sm">Scandium Free</h5>
                    <p className="text-lg font-bold text-cyan-400 mt-1">$0 <span className="text-xs text-slate-400 font-normal">/ mo</span></p>
                    <ul className="mt-3 space-y-1.5 text-[11px] text-slate-300">
                      <li>• Local AI (up to 3B models)</li>
                      <li>• Copilot Assistant Mode</li>
                      <li>• 1 Device Activation</li>
                      <li>• Zero Cloud Fees</li>
                    </ul>
                  </div>
                  <span className="text-center py-1.5 rounded-lg text-xs bg-slate-800 text-slate-400 font-medium">
                    Current Baseline
                  </span>
                </div>

                {/* Plus Tier */}
                <div className="p-4 bg-slate-900 border border-cyan-500/40 rounded-xl space-y-3 flex flex-col justify-between relative shadow-sm">
                  <span className="absolute -top-2.5 right-3 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-cyan-500 text-slate-950">
                    Popular
                  </span>
                  <div>
                    <h5 className="font-bold text-slate-100 text-sm">Scandium Plus</h5>
                    <p className="text-lg font-bold text-cyan-400 mt-1">$19 <span className="text-xs text-slate-400 font-normal">/ mo</span></p>
                    <ul className="mt-3 space-y-1.5 text-[11px] text-slate-300">
                      <li>• Local Whisper Speech-to-Text</li>
                      <li>• Full Local Vision & OCR</li>
                      <li>• Personal Knowledge Base RAG</li>
                      <li>• Standard BYOK (Gemini, Groq)</li>
                      <li>• 2 Device Activations</li>
                    </ul>
                  </div>
                  <button
                    onClick={() => window.open('https://scandium.lemonsqueezy.com/buy/plus', '_blank')}
                    className="text-center py-1.5 rounded-lg text-xs bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold transition-all shadow-sm"
                  >
                    Subscribe ($19/mo)
                  </button>
                </div>

                {/* Pro Tier */}
                <div className="p-4 bg-slate-900 border border-indigo-500/40 rounded-xl space-y-3 flex flex-col justify-between">
                  <div>
                    <h5 className="font-bold text-slate-100 text-sm">Scandium Pro</h5>
                    <p className="text-lg font-bold text-indigo-400 mt-1">$49 <span className="text-xs text-slate-400 font-normal">/ mo</span></p>
                    <ul className="mt-3 space-y-1.5 text-[11px] text-slate-300">
                      <li>• Interview & Coding Copilots</li>
                      <li>• Full BYOK (OpenAI, Claude 3.5)</li>
                      <li>• Priority Whisper Base STT</li>
                      <li>• 100 Document Indexing Limit</li>
                      <li>• 5 Device Activations</li>
                    </ul>
                  </div>
                  <button
                    onClick={() => window.open('https://scandium.lemonsqueezy.com/buy/pro', '_blank')}
                    className="text-center py-1.5 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-bold transition-all shadow-sm"
                  >
                    Subscribe ($49/mo)
                  </button>
                </div>
              </div>
            </div>

            {/* Offline Grace Information */}
            <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl text-xs text-slate-400 space-y-1.5">
              <span className="font-semibold text-slate-300">7-Day Offline Tolerance</span>
              <p className="leading-relaxed">
                Scandium validates your subscription every 24 hours. If you travel or work without an active internet connection, Scandium continues operating in full premium mode for up to 7 consecutive offline days.
              </p>
            </div>
          </div>
        )}

        {/* 2. Hardware Profile & Local AI Engine Pane */}
        {activeTab === 'hardware' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Cpu className="w-5 h-5 text-indigo-400" /> Hardware Profile & Local AI Engine
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Scandium executes open-weight AI models locally on your computer. Zero audio, transcripts, or screenshots leave your machine in Local Mode.
              </p>
            </div>

            {/* Hardware Profile Specs */}
            {hardwareProfile && (
              <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
                <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                  <Gauge className="w-4 h-4 text-cyan-400" /> Detected Hardware Specifications
                </h4>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-1">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">Processor & Architecture</span>
                    <p className="text-slate-200 font-medium truncate">{hardwareProfile.cpuModel}</p>
                    <p className="text-[11px] text-slate-400">{hardwareProfile.cpuCores} cores • {hardwareProfile.arch} ({hardwareProfile.platform})</p>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-1">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">System Memory (RAM)</span>
                    <p className="text-slate-200 font-medium">{Math.round(hardwareProfile.totalRamMb / 1024)} GB Total ({Math.round(hardwareProfile.availableRamMb / 1024)} GB Free)</p>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
                      <div
                        className="bg-cyan-500 h-full rounded-full"
                        style={{ width: `${Math.min(100, Math.round(((hardwareProfile.totalRamMb - hardwareProfile.availableRamMb) / hardwareProfile.totalRamMb) * 100))}%` }}
                      />
                    </div>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-1">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">Graphics Acceleration (GPU)</span>
                    <p className="text-slate-200 font-medium truncate">{hardwareProfile.primaryGpu?.name || 'Integrated Graphics'}</p>
                    <p className="text-[11px] text-slate-400">
                      {hardwareProfile.isIntelArc ? 'Intel Arc Architecture (DirectML / OpenVINO)' : hardwareProfile.isAppleSilicon ? 'Apple Silicon (Metal)' : hardwareProfile.isNvidiaCuda ? 'NVIDIA (CUDA)' : 'Standard Display'}
                    </p>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-1">
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">Storage Capacity</span>
                    <p className="text-slate-200 font-medium">{Math.round(hardwareProfile.freeDiskMb / 1024)} GB Free / {Math.round(hardwareProfile.totalDiskMb / 1024)} GB Total</p>
                    <p className="text-[11px] text-slate-400">Ample storage for quantized weights</p>
                  </div>
                </div>

                {hardwareProfile.warnings?.length > 0 && (
                  <div className="space-y-1.5">
                    {hardwareProfile.warnings.map((w: string, idx: number) => (
                      <div key={idx} className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Local Whisper Speech-to-Text Section */}
            <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                    <Radio className="w-4 h-4 text-emerald-400" /> Local Speech-to-Text (whisper.cpp)
                  </h4>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Transcribes live microphone & system audio locally on your CPU/iGPU. \$0 cloud cost.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                {whisperModels.map(m => (
                  <div key={m.id} className="p-3 bg-slate-950 rounded-lg border border-slate-800 flex items-center justify-between text-xs">
                    <div>
                      <span className="font-semibold text-slate-200">{m.name}</span>
                      <p className="text-[11px] text-slate-500">{Math.round(m.sizeBytes / (1024 * 1024))} MB • Quantized GGML</p>
                    </div>

                    <div className="flex items-center gap-2">
                      {m.isDownloaded ? (
                        <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-semibold px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                        </span>
                      ) : downloadingWhisperId === m.id ? (
                        <span className="text-[11px] text-cyan-400 font-semibold">Downloading...</span>
                      ) : (
                        <button
                          onClick={() => handleDownloadWhisperModel(m.id)}
                          className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-semibold"
                        >
                          Download
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Local Ollama LLM Runtime Section */}
            <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-indigo-400" /> Ollama Local LLM Runtime
                  </h4>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Endpoint: <code className="text-slate-300 font-mono">http://127.0.0.1:11434</code>
                  </p>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded font-semibold uppercase tracking-wider ${
                  ollamaStatus?.isRunning
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                }`}>
                  {ollamaStatus?.isRunning ? `Running (v${ollamaStatus.version || '0.4'})` : 'Offline'}
                </span>
              </div>

              {!ollamaStatus?.isRunning ? (
                <div className="p-4 bg-slate-950/80 border border-amber-500/30 rounded-xl text-xs space-y-3">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <span className="font-bold text-amber-200">First-Run Setup: Local Ollama Runtime Required</span>
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        To maintain \$0 cloud cost, Scandium runs language models on your computer using the open-source Ollama runtime. Follow these steps to activate local AI:
                      </p>
                    </div>
                  </div>

                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800 space-y-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="w-4 h-4 rounded-full bg-cyan-500/20 text-cyan-400 font-bold flex items-center justify-center text-[10px]">1</span>
                      <span className="text-slate-200">Download and install Ollama from the official release:</span>
                    </div>
                    <div className="pl-6">
                      <button
                        onClick={() => window.open('https://ollama.com/download', '_blank')}
                        className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded font-semibold text-xs transition-colors"
                      >
                        Download Ollama (Official Installer)
                      </button>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <span className="w-4 h-4 rounded-full bg-cyan-500/20 text-cyan-400 font-bold flex items-center justify-center text-[10px]">2</span>
                      <span className="text-slate-200">Start Ollama or execute in a terminal:</span>
                    </div>
                    <div className="pl-6">
                      <code className="bg-slate-950 px-2 py-1 rounded text-cyan-300 font-mono text-[10px] border border-slate-800">
                        ollama run llama3.2:1b
                      </code>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <span className="w-4 h-4 rounded-full bg-cyan-500/20 text-cyan-400 font-bold flex items-center justify-center text-[10px]">3</span>
                      <span className="text-slate-200">Verify connection once Ollama is active:</span>
                    </div>
                    <div className="pl-6">
                      <button
                        onClick={loadHardwareAndModels}
                        className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded font-medium text-xs border border-slate-700 transition-colors"
                      >
                        Check Connection
                      </button>
                    </div>
                  </div>

                  <p className="text-[10px] text-slate-400 leading-tight">
                    Hardware acceleration: Intel Arc, NVIDIA, or Apple GPUs are automatically utilized. Systems without dedicated accelerators seamlessly fall back to multi-threaded CPU execution.
                  </p>
                </div>
              ) : (
                <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-lg text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400" /> Test Local Generation
                    </span>
                    <button
                      onClick={() => handleTestOllama()}
                      disabled={testGenLoading || installedOllamaModels.length === 0}
                      className="px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-[11px] font-semibold disabled:opacity-40 transition-colors"
                    >
                      {testGenLoading ? 'Generating...' : 'Run Generation Test'}
                    </button>
                  </div>
                  {testGenResult && (
                    <div className={`p-2 rounded text-[11px] font-mono leading-relaxed border ${
                      testGenResult.success
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                        : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                    }`}>
                      {testGenResult.success ? (
                        <>
                          <div className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider mb-0.5">
                            Verified ({testGenResult.latencyMs} ms latency)
                          </div>
                          <p>{testGenResult.text}</p>
                        </>
                      ) : (
                        <div>Test failed: {testGenResult.error}</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Installed Models */}
              <div className="space-y-2">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Installed Local Models</span>
                {installedOllamaModels.length === 0 ? (
                  <p className="text-xs text-slate-500 italic p-2 bg-slate-950 rounded border border-slate-800/60">
                    No models installed in Ollama yet. Select a recommended model below to download.
                  </p>
                ) : (
                  installedOllamaModels.map(m => (
                    <div key={m.name} className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-semibold text-slate-200">{m.name}</span>
                        <span className="ml-2 text-[11px] text-slate-500 font-mono">({(m.sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB)</span>
                      </div>
                      <button
                        onClick={() => handleDeleteModel(m.name)}
                        className="text-slate-500 hover:text-rose-400 p-1"
                        title="Delete model"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Curated Catalog */}
              <div className="space-y-2 pt-2 border-t border-slate-800/80">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Recommended Models for Your Hardware</span>
                <div className="space-y-2">
                  {catalogModels.map(c => {
                    const isInstalled = installedOllamaModels.some(m => m.name.startsWith(c.tag) || m.tag.startsWith(c.tag));
                    return (
                      <div key={c.tag} className="p-3 bg-slate-950 rounded-lg border border-slate-800 flex items-center justify-between text-xs">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-200">{c.name}</span>
                            <span className="font-mono text-[10px] text-cyan-400 bg-cyan-950/60 px-1 rounded border border-cyan-800/40">{c.tag}</span>
                            {c.isRecommended && (
                              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                Recommended
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 leading-tight">{c.description}</p>
                          <p className="text-[10px] text-slate-500 font-mono">Size: ~{c.diskSizeGb} GB • Requires: {c.minRamGb} GB RAM</p>
                        </div>

                        <div>
                          {isInstalled ? (
                            <span className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Installed
                            </span>
                          ) : pullingModelName === c.tag ? (
                            <span className="text-[11px] text-cyan-400 font-semibold animate-pulse">{pullProgress || 'Downloading...'}</span>
                          ) : (
                            <button
                              onClick={() => handlePullModel(c.tag)}
                              disabled={!ollamaStatus?.isRunning}
                              className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium border border-slate-700 disabled:opacity-40"
                            >
                              Download
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

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
                  <option value="gemini-3.5-flash-lite">Google Gemini 3.5 Flash-Lite (Sub-second &lt;1s Latency - Recommended)</option>
                  <option value="gemini-3.6-flash">Google Gemini 3.6 Flash (Fast Multimodal)</option>
                  <option value="gemini-3.8-flash">Google Gemini 3.8 Flash (Deep Multimodal)</option>
                  <option value="gemini-3.1-pro-preview">Google Gemini 3.1 Pro Preview (Deep Complex Reasoning)</option>
                  <option value="gpt-4o">OpenAI GPT-4o (Multimodal Vision)</option>
                  <option value="gpt-4o-mini">OpenAI GPT-4o Mini (Fast & Cost Efficient)</option>
                  <option value="claude-sonnet-5-5">Anthropic Claude Sonnet 5.5 (Recommended Balanced Claude)</option>
                  <option value="claude-haiku-5-5">Anthropic Claude Haiku 5.5 (Fastest / Low Latency)</option>
                  <option value="claude-opus-5-5">Anthropic Claude Opus 5.5 (Complex Agentic Coding)</option>
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
                These hotkeys function globally across your operating system even when other windows are focused. Emergency Stop immediately stops microphone and system-audio capture and cancels active AI/STT work; it does not delete saved history. Emergency Stop immediately stops microphone and system-audio capture and cancels active AI/STT work; it does not delete saved history.
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
                <Monitor className="w-5 h-5 text-cyan-400" /> Scandium Desktop Application
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Scandium is designed as an independent native desktop AI assistant with advanced capabilities. Anyone can download, build, and run this application on Windows, macOS, or Linux.
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

        {activeTab === 'security' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                <Shield className="w-5 h-5 text-cyan-400" /> Privacy & Security Governance
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Zero-trust local privacy architecture, outbound credential scrubbing, hardware-bound credential vault, and meeting consent guard.
              </p>
            </div>

            {/* Enterprise Mode Master Toggle */}
            <div className={`p-4 rounded-xl border transition-all ${
              state.enterpriseMode
                ? 'bg-amber-500/10 border-amber-500/30'
                : 'bg-slate-900 border-slate-800'
            }`}>
              <div className="flex items-center justify-between">
                <div className="space-y-1 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                      Enterprise Compliance Mode
                    </span>
                    {state.enterpriseMode && (
                      <span className="text-[10px] bg-amber-500/20 text-amber-300 font-semibold px-2 py-0.5 rounded border border-amber-500/40">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    When active, locks inference strictly to local Ollama, forces zero cloud egress, suppresses session transcript writes to disk, and disables all telemetry. Recommended for regulated or confidential workflows.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => patchState(prev => ({ enterpriseMode: !prev.enterpriseMode }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 transition-all ${
                    state.enterpriseMode
                      ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-md'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
                  }`}
                >
                  {state.enterpriseMode ? 'Disable Enterprise' : 'Enable Enterprise'}
                </button>
              </div>
            </div>

            {/* Privacy Mode (Local vs Cloud) */}
            <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                    Inference Privacy Mode
                  </h4>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Controls whether AI queries and transcript tokens stay on-device or use external AI providers.
                  </p>
                </div>
                {state.enterpriseMode && (
                  <span className="text-[10px] text-amber-400 font-medium bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                    Locked to Local by Enterprise Mode
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  disabled={state.enterpriseMode}
                  onClick={() => patchState({ privacyMode: 'local' })}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    state.privacyMode === 'local'
                      ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-300'
                      : 'bg-slate-950/60 border-slate-800/80 text-slate-400 hover:border-slate-700'
                  } ${state.enterpriseMode ? 'cursor-not-allowed opacity-90' : ''}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-slate-200">Strict Local Only</span>
                    {state.privacyMode === 'local' && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                  </div>
                  <p className="text-[10px] text-slate-400 leading-tight">
                    Zero cloud transmission. Prompts route directly to local Ollama (localhost:11434). Zero external network calls.
                  </p>
                </button>

                <button
                  type="button"
                  disabled={state.enterpriseMode}
                  onClick={() => patchState({ privacyMode: 'cloud' })}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    state.privacyMode === 'cloud'
                      ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-300'
                      : 'bg-slate-950/60 border-slate-800/80 text-slate-400 hover:border-slate-700'
                  } ${state.enterpriseMode ? 'cursor-not-allowed opacity-40' : ''}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-slate-200">Cloud AI Providers</span>
                    {state.privacyMode === 'cloud' && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                  </div>
                  <p className="text-[10px] text-slate-400 leading-tight">
                    Uses Gemini, OpenAI, Claude, or Groq with client-side credential scrubbing and TLS 1.3 encryption.
                  </p>
                </button>
              </div>
            </div>

            {/* Sensitive-Content Redaction & Outbound Guard */}
            <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
              <div>
                <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-cyan-400" /> Outbound Data Inspection & Redaction
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Client-side filters automatically sanitize text and screenshots before transmission.
                </p>
              </div>

              <div className="space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.redactSensitiveData}
                    onChange={e => patchState({ redactSensitiveData: e.target.checked })}
                    className="mt-0.5 rounded bg-slate-950 border-slate-700 text-cyan-600 focus:ring-cyan-500 focus:ring-offset-slate-900"
                  />
                  <div>
                    <span className="text-xs font-semibold text-slate-200">
                      Automated Sensitive-Content Redaction
                    </span>
                    <p className="text-[10px] text-slate-400 leading-normal">
                      Automatically masks passwords, API keys (sk-..., AKIA..., AIzaSy...), private keys, JWTs, credit card numbers, and MFA codes from prompt context and OCR text with <code className="text-cyan-300">[REDACTED_API_KEY]</code>, <code className="text-cyan-300">[REDACTED_CREDIT_CARD]</code>, etc.
                    </p>
                  </div>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.blockOutboundSecrets}
                    onChange={e => patchState({ blockOutboundSecrets: e.target.checked })}
                    className="mt-0.5 rounded bg-slate-950 border-slate-700 text-cyan-600 focus:ring-cyan-500 focus:ring-offset-slate-900"
                  />
                  <div>
                    <span className="text-xs font-semibold text-slate-200">
                      Block Requests Containing Secrets (Zero Egress Hard-Stop)
                    </span>
                    <p className="text-[10px] text-slate-400 leading-normal">
                      If unredacted sensitive tokens, credentials, or private keys are detected in the payload, immediately abort and reject the request before touching the network.
                    </p>
                  </div>
                </label>
              </div>
            </div>

            {/* Meeting Privacy Guard */}
            <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
              <div>
                <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <EyeOff className="w-3.5 h-3.5 text-cyan-400" /> Meeting Privacy Guard & Audio Consent
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  System audio loopback captures remote participants. Select consent policy to prevent unauthorized recording.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {[
                  { key: 'prompt', label: 'Prompt Every Time', desc: 'Ask for explicit confirmation before every session' },
                  { key: 'allowed_once', label: 'Allow Once', desc: 'Permit loopback for this session only' },
                  { key: 'always_allowed', label: 'Always Allow', desc: 'Permit loopback capture automatically' },
                  { key: 'denied', label: 'Deny Loopback', desc: 'Strictly block remote audio capture' },
                ].map(opt => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => patchState({ meetingConsent: opt.key as any })}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      state.meetingConsent === opt.key
                        ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-300'
                        : 'bg-slate-950/60 border-slate-800/80 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                      <span>{opt.label}</span>
                      {state.meetingConsent === opt.key && <Check className="w-3 h-3 text-cyan-400" />}
                    </div>
                    <p className="text-[10px] text-slate-500 leading-tight mt-0.5">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Local Data Storage & Screenshot Ephemerality */}
            <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
              <div>
                <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-cyan-400" /> Local Data Storage & Cryptography
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Cryptographic protection for local transcripts and screenshot memory lifecycle.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-slate-950/70 rounded-lg border border-cyan-900/40">
                  <div className="mt-0.5 p-1 bg-cyan-950/80 rounded border border-cyan-800/60 text-cyan-400">
                    <Shield className="w-4 h-4 text-cyan-400" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-200">
                        AES-256-GCM Storage Encryption
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-950 border border-cyan-800 text-cyan-300 uppercase tracking-wider">
                        Enforced
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-normal mt-1">
                      Stored sessions, shared state, and meeting transcripts are permanently encrypted on disk with authenticated AES-256-GCM backed by the OS hardware keystore (Windows DPAPI, macOS Keychain, Linux Secret Service). Plaintext JSON files are never written directly to the file system.
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 text-[11px] text-slate-400 space-y-1">
                  <div className="flex items-center gap-1.5 text-cyan-400 font-semibold text-xs">
                    <Check className="w-3.5 h-3.5 text-emerald-400" /> Ephemeral-Only Screenshot Memory
                  </div>
                  <p className="text-[10px] leading-tight text-slate-500">
                    Desktop screenshots are kept strictly in volatile RAM, processed through OCR/vision, and immediately wiped with zeros (<code className="text-slate-400">buf.fill(0)</code>). Persistent screenshot image storage on disk is permanently disabled.
                  </p>
                </div>
              </div>
            </div>

            {/* Telemetry Opt-in */}
            <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                    Telemetry & Usage Diagnostics
                  </h4>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Scandium operates under a strict privacy-first default: telemetry is completely OFF.
                  </p>
                </div>
              </div>

              <label className="flex items-start gap-3 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  disabled={state.enterpriseMode}
                  checked={state.telemetryEnabled}
                  onChange={e => patchState({ telemetryEnabled: e.target.checked })}
                  className="mt-0.5 rounded bg-slate-950 border-slate-700 text-cyan-600 focus:ring-cyan-500 focus:ring-offset-slate-900"
                />
                <div>
                  <span className="text-xs font-semibold text-slate-200">
                    Help improve the app by sharing anonymous usage data
                  </span>
                  <p className="text-[10px] text-slate-400 leading-normal">
                    {state.enterpriseMode
                      ? 'Disabled and blocked by Enterprise Mode.'
                      : 'Disabled by default. When enabled, transmits only anonymous performance metrics and error stack traces. No audio, transcripts, images, or API keys are ever collected.'}
                  </p>
                </div>
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
