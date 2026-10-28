# Cluely Copilot: Reverse-Engineered Desktop AI Assistant

An evidence-driven, clean-room desktop AI assistant reverse-engineered from **Cluely** using **REA (Reverse Engineer Anything)**. Built with **TypeScript**, **Electron**, **React**, and **Tailwind CSS**, it operates alongside everyday desktop workflows (video meetings, coding sessions, technical interviews, sales calls, and presentations).

Unlike basic chatbots or note-taking apps, this application continuously interprets both what is **happening on your screen** and what is **being spoken in live conversation**, fusing these signals with user prompts and personal knowledge to provide real-time, context-grounded AI guidance.

---

## 1. Key Capabilities

* **Live Screen Understanding**:
  * Real-time display capture via Electron `desktopCapturer`.
  * Multi-display awareness: automatically matches and captures the screen containing the active assistant window.
  * Adaptive aspect-ratio downscaling: displays exceeding 1920px max dimension are scaled down proportionally to ensure minimal multimodal latency and optimal token consumption.
  * Vision AI interpretation for code editors, compiler errors, presentation slides, meeting screens, and documentation.

* **Dual-Stream Conversation Audio Understanding**:
  * **Dual-Channel Speaker Separation**: Local microphone (`me`) and remote participants via Windows system audio loopback (`them`) are ingested as independent streams.
  * **Native Loopback Capture**: Implements `session.defaultSession.setDisplayMediaRequestHandler` with `audio: "loopback"` on Windows, eliminating the need for virtual audio cable drivers.
  * **Voice Activity Detection (VAD)**: Powered by 16kHz resampling and an energy/Silero VAD state machine featuring a 300ms silence redemption window and a 20-second maximum speech segment cap.
  * **Crosstalk & Speaker Echo Suppression**: Automatically zeroes out local microphone input when remote participant audio is active, eliminating acoustic feedback from laptop speakers.
  * **Real-Time Speech-to-Text**: Encodes speech into 16-bit PCM WAV chunks and streams them through ultra-fast cloud STT (Groq Whisper at <300ms latency, OpenAI Whisper) to populate a live transcript timeline with speaker labels and timestamps.

* **Floating Assistant Overlay**:
  * Frameless, transparent floating pill (`width: 380, height: 52`, `alwaysOnTop: true`, `type: 'panel'`, `skipTaskbar: true`).
  * Custom drag regions with snap-to-edge desktop bounds clamping.
  * Expandable docked chat card displaying streaming markdown, code syntax blocks, and follow-up chips.

* **Screen Sharing Stealth Mode (`setContentProtection`)**:
  * Integrates `win.setContentProtection(true)` to enforce OS-level display affinity (`WDA_EXCLUDEFROMCAPTURE` on Windows, `NSWindowSharingNone` on macOS).
  * When enabled, meeting software such as **Zoom**, **Microsoft Teams**, **Google Meet**, and **Slack** cannot capture the assistant window—it remains completely invisible to other call participants.

* **Context Fusion & Grounded Reasoning**:
  * Unified prompt synthesizer combining recent spoken transcript lines, high-resolution visual context, user queries, and retrieved knowledge passages.
  * Multiple specialized assistance modes:
    * `Copilot`: Concise general desktop assistant.
    * `Interview`: Technical interview copilot delivering optimal algorithms, time/space complexities $O(...)$, clean code, and talking points.
    * `Coding`: Software engineer debugger identifying root causes from stack traces and compiler errors.
    * `Sales`: Live objection handling and value proposition prompts.
    * `Executive`: Meeting minutes, decisions, and action items.

* **Local Knowledge Base & Retrieval (RAG)**:
  * Import custom Markdown notes, resumes, API documentation, and code snippets.
  * Overlapping text chunking (500 tokens with 80-token overlap).
  * Local TF-IDF keyword & semantic cosine retrieval with source attribution.

* **Privacy & Bring-Your-Own-Key (BYOK)**:
  * Zero raw audio retention: audio buffers exist only in ephemeral memory and are discarded after transcription.
  * Explicit capture indicators on the floating pill.
  * Local credential vault with zero cloud dependency for key storage.

---

## 2. Reverse Engineering with REA

This project was built following an evidence-driven reverse engineering methodology:

```text
Target Binary (Cluely Setup 2.0.195.exe, v2.0.198)
  └── ASAR Bundle (resources/app.asar)
        ├── dist-electron/main.js (Main Process)
        ├── dist-electron/preload.mjs (Preload Bridge)
        ├── dist/assets/transcription-*.js (VAD & Audio Engine)
        └── dist/assets/streamdown-*.js (Multimodal Context Upload)
```

### REA Evidence Details
* **REA Tooling**: `rea-agents` v6.7.0 (CLI & MCP server)
* **Evidence Identifier**: `ev_3f579700396e22cdcbce959e9489a2654a013788e6c20143a4653533e58d23d9`
* **Root Artifact SHA-256**: `abeccf8a494b76cb8d4908e0fff0b011a791d7f26309cfc16e06e429c501901e`
* **Analyzed Entrypoint**: `dist-electron/main.js` (SHA-256: `3c036a0d6b30fc29dd42fde30a338dd381c8ed3ad0a6bed38a8d0c43e920b0a4`)

### Observable Behaviors Verified from Cluely
1. **Window Protection**: Direct call to `win.setContentProtection(ue(e))` inside window initialization.
2. **Audio Architecture**: Microphone ingested via `node-record-lpcm16` / `sox.exe` (`role: "me"`), system loopback via `setDisplayMediaRequestHandler` with `audio: "loopback"` (`role: "them"`).
3. **Echo Suppression**: In `transcription-*.js`:
   ```javascript
   if (role === 'me' && state.themHasVoiceActivity) {
     frame = new Float32Array(frame.length); // Suppress local mic during remote speech
   }
   ```
4. **Thumbnail Scaling**: In `screenshot.ts`:
   ```javascript
   function calculateThumbnailSize(bounds) {
     let maxDim = Math.max(bounds.width, bounds.height);
     if (maxDim <= 1920) return bounds;
     let ratio = 1920 / maxDim;
     return { width: Math.round(bounds.width * ratio), height: Math.round(bounds.height * ratio) };
   }
   ```
5. **IPC Origin Verification**: Strict validation of `event.senderFrame.url` to prevent origin spoofing or untrusted iframe injection.

---

## 3. System Architecture

```mermaid
flowchart TD
    subgraph PrivilegedMain ["Electron Main Process (app/electron/)"]
        Coord["WindowCoordinator (Floating Pill + Chat Card + Dashboard)"]
        Shortcuts["ShortcutManager (Global Accelerators)"]
        ScreenSvc["ScreenshotService (desktopCapturer + 1920px Downscale)"]
        StateMgr["StateManager (shared-state.json Persistence)"]
        IpcSec["IpcRouter (Origin Guard & Loopback Media Handler)"]
    end

    subgraph SandboxedUI ["Sandboxed Renderer (app/src/)"]
        PillUI["FloatingBar (Pill Controls, Mic Status, Stealth Toggle)"]
        ChatUI["ChatPanel (Markdown Streaming, Code Blocks, Visual Previews)"]
        TransUI["TranscriptLive (Speaker-Tagged Live Transcript)"]
        DashUI["Dashboard (API Keys, Shortcuts, Knowledge RAG)"]
        AudioEng["Audio Pipeline (48kHz -> 16kHz Resampler + VAD + Echo Cancel)"]
    end

    subgraph AIAdapters ["Pluggable AI & Perception Layer (app/src/lib/)"]
        Gemini["Google Gemini 2.0 / 1.5 Flash (Vision + Reasoning)"]
        OpenAI["OpenAI GPT-4o (Vision + Reasoning)"]
        Groq["Groq Whisper (<300ms Cloud Speech-to-Text)"]
        RAG["Knowledge Retriever (TF-IDF & Overlapping Chunks)"]
    end

    Shortcuts -->|Triggers| Coord
    Coord <-->|Position & Drag| PillUI
    IpcSec <-->|Typed IPC Bridge| SandboxedUI
    ScreenSvc -->|Optimized PNG| ChatUI
    AudioEng -->|WAV Segments| Groq
    Groq -->|Recognized Text| TransUI
    TransUI -->|Transcript Context| Gemini
    ScreenSvc -->|Visual Context| Gemini
    RAG -->|Document Context| Gemini
    Gemini -->|Streamed SSE Tokens| ChatUI
```

---

## 4. Repository Structure

```text
.
├── docs/                               # Project documentation suite
│   ├── reverse-engineering/
│   │   ├── CLUELY_ANALYSIS.md          # Comprehensive evidence & decompiled findings
│   │   └── FEATURE_MATRIX.md           # Target behavior vs. independent implementation
│   ├── architecture/
│   │   └── ARCHITECTURE.md             # System design, boundaries & data flows
│   ├── implementation/
│   │   └── IMPLEMENTATION_PLAN.md      # Milestones and ordered stages (01-07)
│   ├── testing/
│   │   ├── TEST_PLAN.md                # 5-tier testing strategy
│   │   └── TEST_RESULTS.md             # Verified test runs & smoke results
│   ├── security/
│   │   └── SECURITY_AND_PRIVACY.md     # Permissions, stealth & credential vault
│   └── production/
│       └── PRODUCTION_READINESS.md     # Release blockers & acceptance verification
├── cluely_domains_extracted/           # Decompiled domain modules from Cluely
├── app/                                # Clean-room independent desktop implementation
│   ├── package.json                    # Electron, React, Tailwind, Vite, Vitest
│   ├── tsconfig.json                   # TypeScript config for frontend
│   ├── tsconfig.electron.json          # TypeScript config for Electron main
│   ├── vite.config.ts                  # Vite build bundler
│   ├── tailwind.config.js              # Styling & theme configuration
│   ├── index.html                      # App root with strict CSP policy
│   ├── electron/
│   │   ├── main.ts                     # Single instance lock & app lifecycle
│   │   ├── preload.ts                  # Context-isolated desktopBridge
│   │   └── domains/
│   │       ├── windows.ts              # Multi-window coordinator & stealth
│   │       ├── shortcuts.ts            # Global hotkey manager
│   │       ├── screenshot.ts           # Screen capture & thumbnail scaler
│   │       ├── state.ts                # Shared state persistence
│   │       └── ipc-router.ts           # Typed IPC handlers & media loopback
│   ├── src/
│   │   ├── App.tsx                     # Route dispatcher (#control, #chat, #dashboard)
│   │   ├── components/
│   │   │   ├── FloatingBar.tsx         # Frameless floating pill UI
│   │   │   ├── ChatPanel.tsx           # AI response card with markdown streaming
│   │   │   ├── TranscriptLive.tsx      # Real-time transcript with speaker badges
│   │   │   └── Dashboard.tsx           # Settings, models, knowledge & shortcuts
│   │   ├── hooks/
│   │   │   ├── useSharedState.ts       # Reactive shared state synchronization
│   │   │   ├── useAudioCapture.ts      # Web Audio pipeline & VAD dispatch
│   │   │   └── useAiAssistant.ts       # Multimodal context synthesis & streaming
│   │   └── lib/
│   │       ├── types.ts                # Shared state & message contracts
│   │       ├── vad.ts                  # Audio resampler, RMS VAD, RIFF WAV encoder
│   │       ├── providers.ts            # Gemini, OpenAI, and Groq STT adapters
│   │       └── knowledge.ts            # Document chunker & TF-IDF retriever
│   └── tests/
│       ├── audio-vad.test.ts           # Resampling, energy, and VAD unit tests
│       ├── screen-capture.test.ts      # Aspect-ratio downscaling tests
│       ├── ai-context.test.ts          # Prompt synthesis & RAG retrieval tests
│       └── electron-smoke.cjs          # Native desktop launch & lifecycle smoke test
├── LICENSE                             # MIT License
└── README.md                           # Documentation & quickstart guide
```

---

## 5. Getting Started

### Prerequisites
* **Node.js**: v20+ or v24+
* **Operating System**: Windows 10/11 (or macOS / Linux)

### Installation
Clone the repository and install dependencies:
```powershell
cd app
npm install
```

### Running Automated Tests
```powershell
cd app
npm test
```
Runs the Vitest test suite covering:
* 48kHz to 16kHz resampling
* Voice Activity Detection state transitions and silence redemption
* Echo cancellation and crosstalk suppression
* 16-bit PCM RIFF WAV binary encoding
* Aspect-ratio thumbnail downscaling (1080p, 4K, Ultrawide, Portrait)
* Multimodal prompt fusion and speaker tagging
* Document chunking and TF-IDF search relevance

### Building the Project
```powershell
cd app
npm run build
```
Builds the Vite frontend into `app/dist/` and compiles the TypeScript Electron code into `app/dist-electron/`.

### Launching the Desktop Application
```powershell
cd app
npm start
```
The application will launch with the floating pill placed at the top center of your primary display.

---

## 6. Usage & Global Hotkeys

| Hotkey | Action | Description |
|---|---|---|
| `Ctrl + Enter` | **Ask AI / Screen Context** | Captures active display, packages recent conversation, and generates answer |
| `Ctrl + Shift + Space` | **Toggle Visibility** | Shows or hides the floating chat card |
| `Ctrl + Shift + X` | **Toggle Session** | Starts or stops the live conversation listening session |
| `Escape` | **Clear / Collapse** | Clears the active query and collapses the chat card |
| `Ctrl + Up / Down` | **Nudge Y** | Shifts the floating pill vertically by 80px without mouse interaction |
| `Ctrl + Left / Right`| **Nudge X** | Shifts the floating pill horizontally by 80px |

### UI Controls
* **Microphone Pill**: Click to start/stop listening. The pulsing indicator reflects real-time voice activity.
* **Mode Dropdown**: Select between *Copilot*, *Interview*, *Coding*, *Sales*, and *Executive*.
* **Shield Icon**: Toggle screen-sharing stealth mode (uses `setContentProtection`).
* **Gear Icon**: Opens the full Dashboard window to configure API keys (Gemini, OpenAI, Groq), add knowledge documents, or export session transcripts.

---

## 7. Supported AI Models

| Capability | Supported Providers | Recommended Default |
|---|---|---|
| **Multimodal Vision & Reasoning** | Google Gemini 2.0 Flash, OpenAI GPT-4o, Anthropic Claude 3.5 Sonnet, Local Ollama | **Google Gemini 2.0 Flash** |
| **Speech Recognition (STT)** | Groq Whisper Large v3 Turbo, OpenAI Whisper, Deepgram Nova-2, Web Speech API | **Groq Whisper** (<300ms latency) |
| **Local Knowledge RAG** | In-memory TF-IDF / Term Frequency chunk search | Built-in |

---

## 8. License

This project is open-source software licensed under the [MIT License](LICENSE).

---

## 9. Ethical & Responsible Usage Notice

This software is designed as a productivity copilot for meetings, presentations, learning, and software debugging. When using real-time audio capture, ensure you comply with applicable local recording consent laws and wiretapping regulations. Do not use this tool in academic examinations, technical interviews, or environments where automated assistance violates institutional policies or codes of conduct.
