# Cluely Technical Analysis & Reverse-Engineering Report

**Target Subject**: Cluely Desktop Application v2.0.198  
**Analysis Provider**: REA (Reverse Engineer Anything) v6.7.0 (`rea-agents` engine)  
**Evidence Identifier**: `ev_3f579700396e22cdcbce959e9489a2654a013788e6c20143a4653533e58d23d9`  
**Root SHA-256**: `abeccf8a494b76cb8d4908e0fff0b011a791d7f26309cfc16e06e429c501901e`  
**Target Executable**: `Cluely Setup 2.0.195.exe` (222,075,536 bytes)  
**Main Process Artifact**: `dist-electron/main.js` (SHA-256: `3c036a0d6b30fc29dd42fde30a338dd381c8ed3ad0a6bed38a8d0c43e920b0a4`, 527,678 bytes)  
**Renderer Artifacts**: `dist/index.html`, `dist/assets/transcription-tUnQk6kP.js`, `dist/assets/streamdown-text-3Ty2SYlJ.js`, `dist/assets/chat-CPovVDzB.js`

---

## 1. Executive Summary

Cluely is an Electron-based desktop assistant designed to run alongside daily applications (video conferences, coding environments, interviews, presentations, and sales calls). It provides live AI assistance by continuously monitoring two key context vectors:
1. **Audio Context**: Dual-stream speech capture separated into "me" (local microphone) and "them" (remote participants via system audio loopback), with real-time Voice Activity Detection (VAD) and speech transcription.
2. **Screen Context**: On-demand and trigger-based high-resolution display capture, downscaled and transmitted to vision-capable multimodal LLMs.

Our investigation using REA static analysis and artifact inspection revealed the complete architecture, internal module boundaries, IPC contracts, audio capture pipeline, screenshot capture mechanism, and AI interaction protocol.

---

## 2. Desktop Shell & Window Architecture

### 2.1 Multi-Window Layout
Cluely uses four distinct `BrowserWindow` instances coordinated by the Electron main process:
1. **Control Window (`Z.Control`)**:
   - A compact, frameless, transparent floating pill/bar.
   - Draggable across the desktop (`control-window-drag`, `control-window-drag-end`).
   - Displays session status, recording indicators, microphone activity, and action triggers.
   - Stays `alwaysOnTop` with `type: 'panel'` or `type: 'toolbar'` and `skipTaskbar: true`.
2. **Chat Window (`Z.Chat`)**:
   - Anchored directly below or adjacent to the Control Window.
   - Dynamically resizable (`chat-window-resize`, `chat-window-reset-size`).
   - Houses the chat interface, streaming assistant responses, transcript timeline, and follow-up chips.
   - Can expand or collapse (`chatWindowIsExpanded`).
3. **Dashboard Window (`Z.Dashboard`)**:
   - Standard window with title bar (`titleBarStyle: 'hidden'` on Windows, `'hiddenInset'` on macOS).
   - Houses session history, saved transcripts, shortcuts settings, API keys, and account settings.
4. **Meeting Notification Panel**:
   - Dimensions: `width: 360, height: 300`, positioned in the top-right work area corner (`workArea.x + workArea.width - 375, workArea.y + 15`).
   - Pops up alerts for upcoming calendar meetings with quick "Start Listening" buttons.

### 2.2 Anti-Capture & Stealth Rendering (`setContentProtection`)
Observed in `electron/domains/screenshot.ts` and window initialization:
```javascript
n.setContentProtection(ue(e));
```
- Electron's `win.setContentProtection(true)` sets the underlying OS display affinity:
  - **Windows**: Sets `WDA_EXCLUDEFROMCAPTURE` on the window handle, preventing screen-sharing software (Zoom, Microsoft Teams, Google Meet, OBS) from capturing or displaying the floating window.
  - **macOS**: Sets `NSWindowSharingNone`.
- Cluely provides a user toggle (`isInvisible`) allowing users to choose whether the overlay is protected from capture.

### 2.3 Global Shortcuts
Managed in `electron/domains/shortcuts.ts`:
- `toggleVisibility`: Toggles assistant visibility (`showChat`), focusing or blurring the input.
- `ask`: Submits the current question + visual/audio context (`chat-submit`).
- `clear`: Clears input and collapses chat window.
- `toggleSession`: Starts or ends listening session (`control-start-session` / `control-end-session`).
- `moveUp` / `moveDown` / `moveLeft` / `moveRight`: Shifts the floating window by 80px in any direction without requiring mouse interaction.
- `scrollUp` / `scrollDown`: Scrolls chat response by 240px.

---

## 3. Audio & Transcription Pipeline

### 3.1 Dual-Channel Audio Acquisition
Cluely separates speaker streams to ensure accurate attribution and prevent acoustic echo:
- **Local Microphone (`me`)**:
  - Captured on Windows via `node-record-lpcm16` invoking an embedded `sox.exe` (located in `extra-resources/sox-14.4.1-win32/sox.exe`) or Web Audio API.
  - Formatted as 48kHz / 16-bit PCM WAV.
  - Emitted over IPC via `chat-audio-data` with `{ role: 'me', chunk: Buffer }`.
- **System Audio (`them`)**:
  - Captured on Windows using Electron's `session.defaultSession.setDisplayMediaRequestHandler`:
    ```javascript
    session.defaultSession.setDisplayMediaRequestHandler((e, t) => {
      desktopCapturer.getSources({ types: ["screen"] }).then(sources => {
        t({ video: sources[0], audio: "loopback" });
      });
    });
    ```
    This enables Chrome's native loopback audio capture without requiring virtual audio cable drivers!
  - Captured on macOS via an embedded helper binary `audiotee-0.0.7` (`extra-resources/audiotee-0.0.7/audiotee`).
  - Emitted over IPC via `chat-audio-data` with `{ role: 'them', chunk: Buffer }`.

### 3.2 Voice Activity Detection (VAD) & Echo Cancellation
Identified in `dist/assets/transcription-tUnQk6kP.js`:
- Powered by **Silero VAD** run locally via ONNX Runtime Web (`ort-wasm-simd.wasm` / `@ricky0123/vad-web`).
- Configuration:
  - Resampling: 48kHz native input downsampled to 16kHz for Silero VAD (`targetSampleRate: 16000`).
  - Parameters: `redemptionMs: 300`, `preSpeechPadMs: 300`, max segment cap: 20 seconds.
- **Crosstalk / Speaker Echo Suppression**:
  Observed directly in `transcription-tUnQk6kP.js`:
  ```javascript
  E[e] = t => {
    let n = t;
    if (e === 'me' && a().themHasVoiceActivity) {
      n = new Float32Array(t.length); // Suppress mic input while remote audio is playing!
    }
    ...
  }
  ```
  When the remote participant (`them`) is speaking, microphone input on `me` is zeroed out to eliminate double transcription from laptop speakers!

### 3.3 Speech-to-Text Pipeline
- On `SpeechEnd`, the accumulated 16kHz float samples are encoded into a standard 16-bit PCM WAV buffer with a valid RIFF header.
- A placeholder transcript item is added to the active session:
  `{ createdAt, relativeMs, role: 'me' | 'them', status: 'transcribing' }`
- The WAV payload is base64 encoded and dispatched to the transcription API.
- Upon receiving text, the transcript entry status transitions to `'ready'` with the populated `text`.

---

## 4. Screen Understanding Architecture

### 4.1 Capture Mechanism
Identified in `electron/domains/screenshot.ts`:
- Leverages Electron's `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })`.
- Matches the screen on which the assistant is currently placed:
  ```javascript
  let e = Z.Chat.getWindow(),
      t = e ? p.getDisplayMatching(e.getBounds()) : p.getPrimaryDisplay(),
      n = await a.getSources({ types: ["screen"], thumbnailSize: o(t.bounds) });
  ```
- **Adaptive Downscaling**:
  If screen width or height exceeds 1920px, it maintains aspect ratio and downscales so the max dimension is 1920:
  ```javascript
  function o(e) {
    let n = Math.max(e.width, e.height);
    if (n <= 1920) return { width: e.width, height: e.height };
    let r = 1920 / n;
    return { width: Math.round(e.width * r), height: Math.round(e.height * r) };
  }
  ```
- Returns raw PNG buffer `{ data: Buffer, contentType: 'image/png' }`.
- Main process protects against duplicate captures and handles capture retries (3 retries with 500ms delay).

### 4.2 Visual AI Grounding
Identified in `streamdown-text-3Ty2SYlJ.js`:
- Captured screenshots are sent alongside user prompts to vision models.
- The assistant is capable of interpreting code in editors, browser documentation, presentation slides, IDE errors, and video call slides.

---

## 5. IPC Contract & Security

### 5.1 Main-to-Renderer IPC Channels
| Channel | Type | Direction | Payload | Description |
|---|---|---|---|---|
| `get-shared-state` | Invoke | Renderer -> Main | `void` | Returns current shared application state |
| `patch-shared-state` | Invoke | Renderer -> Main | `Partial<SharedState>` | Patches shared application state |
| `capture-screenshot` | Invoke | Renderer -> Main | `void` | Triggers display capture and returns PNG |
| `control-window-drag` | Send | Renderer -> Main | `{ x: number, y: number }` | Relocates floating pill |
| `control-window-drag-end` | Send | Renderer -> Main | `void` | Snaps/bounds window position |
| `control-window-toggle-chat` | Send | Renderer -> Main | `void` | Toggles chat expansion |
| `chat-window-resize` | Send | Renderer -> Main | `{ height: number }` | Sets chat card height |
| `permissions-check` | Send | Renderer -> Main | `void` | Verifies microphone/screen permissions |
| `permissions-ask-for-access`| Send | Renderer -> Main | `{ device: string }` | Prompts OS permission dialog |
| `shared-state-updated` | Broadcast | Main -> Renderer | `SharedState` | Emitted whenever any state changes |
| `chat-audio-data` | Broadcast | Main -> Renderer | `{ role: 'me'\|'them', chunk: Buffer }` | Raw audio stream |
| `chat-submit` | Broadcast | Main -> Renderer | `void` | Triggered by global shortcut to ask |
| `chat-focus-input` | Broadcast | Main -> Renderer | `void` | Focuses text input field |
| `chat-clear-input` | Broadcast | Main -> Renderer | `void` | Clears text input field |
| `control-start-session` | Broadcast | Main -> Renderer | `void` | Initiates new session |
| `control-end-session` | Broadcast | Main -> Renderer | `void` | Terminates active session |

### 5.2 Origin Validation
Cluely main process implements strict sender frame origin validation in `common/ipc.ts`:
```javascript
function ly(e) {
  if (!uy(e)) throw Error(`Rejected IPC sender with invalid origin: ${e?.url}`);
}
function uy(e) {
  return !e || !URL.canParse(e.url) ? false : new URL(e.url).origin === cy;
}
```
This guarantees that external web views or injected iframes cannot invoke privileged desktop capabilities.

---

## 6. Context Synthesis & AI Response Flow

When a user triggers an answer (either by pressing Enter in the chat pill or using the global shortcut):
1. **Message Initialized**: A new message record is created with a unique UUID.
2. **Context Assembly**:
   - **Visual Snapshot**: Desktop screen captured via `capture-screenshot`.
   - **Recent Conversation**: Live audio transcript segments from `me` and `them` (with relative timestamps).
   - **User Query**: Explicit text entered or implied question from latest speech.
   - **Assistance Mode**: Selected preset instructions (Coding, Technical Interview, Sales, Meeting Summary, General Copilot).
   - **Knowledge Base**: Retrieved chunks from imported documents or notes.
3. **Streaming Generation**:
   - Streamed token-by-token using SSE or WebSockets.
   - Assistant UI renders Markdown, code blocks with syntax highlighting, and copy buttons.
4. **Session Persistence**:
   - Transcript, questions, answers, and summaries are saved to local persistent storage.

---

## 7. Implications for Independent Implementation

Our clean-room implementation will reproduce all critical observable capabilities discovered:
1. **Desktop Shell**: Electron + TypeScript + Vite + React + Tailwind CSS with multi-window coordination, frameless floating pill, content protection toggle, and global shortcuts.
2. **Audio Pipeline**: Dual-channel mic + Windows loopback audio, Silero VAD (with energy VAD fallback), crosstalk suppression, and multi-provider STT (Whisper, Deepgram, Google Cloud Speech).
3. **Screen Understanding**: Native `desktopCapturer` with 1920px aspect-ratio downscaling and multimodal LLM integration (Gemini 2.0 / 1.5 Flash, GPT-4o, Claude 3.5 Sonnet).
4. **Context Manager**: Unified context synthesis combining speech timeline, visual evidence, user instructions, and local knowledge retrieval.
5. **Security & Privacy**: Zero raw-audio persistence by default, local credential vault, strict IPC origin enforcement, and explicit capture indicators.

