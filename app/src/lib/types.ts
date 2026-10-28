export type Role = 'me' | 'them';

export interface TranscriptItem {
  id: string;
  createdAt: string;
  relativeMs: number;
  role: Role;
  status: 'transcribing' | 'ready';
  text: string;
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
  activeModel: 'gemini-2.5-flash' | 'gpt-4o' | 'claude-3-5-sonnet' | 'groq-whisper' | 'ollama';
  apiKeys: {
    gemini?: string;
    openai?: string;
    anthropic?: string;
    groq?: string;
    deepgram?: string;
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
  session: {
    id: string;
    createdAt: string;
    audioInputLanguage: string;
    transcript: TranscriptItem[];
    messages: ChatMessage[];
  } | null;
  knowledgeDocs: KnowledgeDoc[];
}

export interface DesktopBridge {
  getSharedState: () => Promise<SharedState>;
  patchSharedState: (patch: Partial<SharedState>) => Promise<void>;
  captureScreenshot: () => Promise<{ data: string; contentType: string }>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  toggleStealthMode: (enable: boolean) => Promise<boolean>;
  dragControlWindow: (pos: { x: number; y: number }) => void;
  dragControlWindowEnd: () => void;
  resizeChatWindow: (height: number) => void;
  openDashboard: (tab?: string) => void;
  onSharedStateUpdated: (callback: (state: SharedState) => void) => () => void;
  onAudioChunk: (callback: (data: { role: Role; chunk: ArrayBuffer }) => void) => () => void;
  onShortcutAction: (callback: (action: string) => void) => () => void;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

