export type Role = 'me' | 'them';

export interface TranscriptItem {
  id: string;
  createdAt: string;
  relativeMs: number;
  role: Role;
  status: 'transcribing' | 'ready' | 'error';
  text: string;
  error?: string;
  confidence?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  screenshot?: string; // Base64 PNG image
  transcriptContext?: string;
  sources?: string[];
  isStreaming?: boolean;
}

export type AssistantMode = 'copilot' | 'interview' | 'coding' | 'sales' | 'executive';

export interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  chunks: string[];
  addedAt: string;
  sourceType?: 'pasted' | 'file';
  fileName?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  mode: string;
  transcriptCount: number;
  messageCount: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  mode: AssistantMode;
  audioInputLanguage: string;
  transcript: TranscriptItem[];
  messages: ChatMessage[];
  summary?: string;
}

export interface SharedState {
  appVersion: string;
  isControlWindowLoaded: boolean;
  isChatWindowLoaded: boolean;
  isDashboardWindowLoaded: boolean;
  showChat: boolean;
  showDashboard: boolean;
  chatWindowIsExpanded: boolean;
  isStealthMode: boolean; // win.setContentProtection
  meHasVoiceActivity: boolean;
  themHasVoiceActivity: boolean;
  isCapturingScreenshot: boolean;
  isRecording: boolean;
  activeMode: AssistantMode;
  activeModel: 'gemini-2.5-flash' | 'gpt-4o' | 'claude-3-5-sonnet' | 'ollama';
  hasApiKeys: {
    gemini: boolean;
    openai: boolean;
    anthropic: boolean;
    groq: boolean;
    ollama: boolean;
  };
  shortcuts: {
    toggleVisibility: string;
    ask: string;
    clear: string;
    toggleSession: string;
    moveUp: string;
    moveDown: string;
    moveLeft: string;
    moveRight: string;
  };
  session: SessionRecord | null;
  knowledgeDocs: KnowledgeDoc[];
}

export interface DesktopBridge {
  getSharedState: () => Promise<SharedState>;
  patchSharedState: (patch: Partial<SharedState>) => Promise<SharedState>;
  captureScreenshot: () => Promise<{ data: string; contentType: string; width: number; height: number }>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  toggleStealthMode: (enable: boolean) => Promise<boolean>;
  dragControlWindow: (pos: { x: number; y: number }) => void;
  dragControlWindowEnd: () => void;
  resizeChatWindow: (height: number) => void;
  openDashboard: (tab?: string) => void;

  // Credential Vault
  saveApiKey: (provider: string, key: string) => Promise<void>;
  deleteApiKey: (provider: string) => Promise<void>;
  getHasApiKeys: () => Promise<Record<string, boolean>>;

  // AI & Speech Providers executed through secure Main process
  executeAiStream: (options: {
    model: string;
    mode: AssistantMode;
    query: string;
    screenshotBase64?: string;
    recentTranscript: TranscriptItem[];
    knowledgePassages?: string[];
  }) => Promise<{ content: string; sources?: string[] }>;

  transcribeAudioPayload: (options: {
    wavBase64: string;
    language?: string;
  }) => Promise<{ text: string }>;

  // Session Repository
  saveSessionRecord: (session: SessionRecord) => Promise<void>;
  listPastSessions: () => Promise<SessionSummary[]>;
  getPastSession: (id: string) => Promise<SessionRecord | null>;
  deletePastSession: (id: string) => Promise<boolean>;
  purgeAllPastSessions: () => Promise<void>;

  // Event Subscriptions
  onSharedStateUpdated: (callback: (state: SharedState) => void) => () => void;
  onAudioChunk: (callback: (data: { role: Role; chunk: ArrayBuffer }) => void) => () => void;
  onShortcutAction: (callback: (action: string) => void) => () => void;
  onAiTokenStream: (callback: (token: string) => void) => () => void;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
