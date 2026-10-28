# Security & Privacy Specification

## 1. Core Security Guarantees
Because a desktop assistant processes microphone audio, screen captures, documents, and API credentials, security is an architectural requirement:

1. **Explicit Capture Consent & Persistent Indicators**:
   - Audio capture and screen capture are never started silently.
   - When active, the floating pill displays a high-visibility animated indicator (pulsing red dot for mic, camera icon for screen).
   - An immediate "Stop Listening" control is accessible at all times via UI click or global shortcut (`Ctrl+Shift+X` / `Alt+S`).

2. **Ephemeral Audio & Screen Processing**:
   - **Zero Raw-Audio Persistence**: Audio buffers are held strictly in memory during live VAD processing. As soon as a speech segment is transcribed, the raw WAV buffer is purged from memory. No audio is ever written to disk unless the user explicitly exports a diagnostic recording.
   - **Zero Unprompted Screenshot Retention**: Screenshots are captured only at the exact instant the user triggers an answer or enables visual context. The image is held in memory for the duration of the API call and immediately released.

3. **Screen Sharing Stealth (`setContentProtection`)**:
   - The application provides a user-controlled toggle (`isStealthMode`).
   - When enabled, Electron applies `win.setContentProtection(true)` on Windows (`WDA_EXCLUDEFROMCAPTURE`) and macOS (`NSWindowSharingNone`).
   - This ensures that when the user is sharing their screen in Zoom, Teams, Google Meet, or Slack, the floating assistant and any answers are completely excluded from the video stream.

4. **Credential & Secret Protection**:
   - API keys (Gemini, OpenAI, Groq, Deepgram, Anthropic) are never hardcoded or stored in Git.
   - Stored locally in user application data encrypted via Node `crypto` or OS credential vault (`safeStorage` where available).
   - Renderer processes never receive decrypted keys directly; requests are proxied or executed through controlled handlers.
   - Secrets are masked in logs and diagnostic outputs (`sk-...xxxx`).

5. **Strict Electron Sandbox & IPC Security**:
   - `contextIsolation: true` is enforced on all browser windows.
   - `nodeIntegration: false` is enforced on all browser windows.
   - IPC origin guard: All IPC message handlers verify `senderFrame.url` against `file://` or the authorized application origin before executing. Any unexpected origin is rejected immediately.
   - Narrowly scoped preload bridge: Only typed, vetted functions are exposed on `window.desktopBridge`.

6. **Local Knowledge Isolation**:
   - Documents indexed into the knowledge base are stored within the application's local user data folder.
   - Embeddings and chunks are isolated per workspace/session and never sent to external servers except as necessary context chunks in explicit user queries.
   - One-click "Purge All Data" wipes all stored sessions, cached chunks, and configuration.

