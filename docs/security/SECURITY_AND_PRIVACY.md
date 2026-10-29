# Security & Privacy Specification

## 1. Core Security Guarantees
Because a desktop copilot processes microphone audio, screen captures, documents, and API credentials, security is an architectural requirement:

1. **Explicit Capture Consent & Persistent Indicators**:
   - Audio capture and screen capture are never started silently.
   - When active, the floating pill displays a high-visibility animated indicator (pulsing red dot for mic, active camera indicator for screen).
   - An immediate "Stop Listening" control is accessible at all times via UI click or global shortcut (`Ctrl+Shift+X` / `Alt+S`).

2. **Ephemeral Audio & Screen Processing**:
   - **Zero Raw-Audio Persistence**: Audio buffers are held strictly in memory during live VAD processing. As soon as a speech segment is transcribed, the raw WAV buffer is purged from memory. No audio is ever written to disk unless the user explicitly exports a diagnostic recording.
   - **Zero Unprompted Screenshot Retention**: Screenshots are captured only at the exact instant the user triggers an answer or enables visual context. The image is held in memory for the duration of the API call and immediately released.
   - **Screenshot Base64 Stripping on Disk**: Before session records are persisted to disk in the `SessionRepository` or saved locally, all base64 screenshot blobs are stripped from the messages array to prevent unbounded storage growth and disk leakage.

3. **Screen Sharing Stealth (`setContentProtection`)**:
   - The application provides a user-controlled toggle (`isStealthMode`).
   - When enabled, Electron applies `win.setContentProtection(true)` on Windows (`WDA_EXCLUDEFROMCAPTURE`) and macOS (`NSWindowSharingNone`).
   - This ensures that when the user is sharing their screen in Zoom, Teams, Google Meet, or Slack, the floating assistant and any answers are completely excluded from the video stream.

4. **Credential & Secret Protection (Dual-Tier Architecture)**:
   - **Desktop Environment (Hardware-Backed OS Vault)**:
     - API keys (Gemini, OpenAI, Anthropic, Groq) are protected via Electron's `safeStorage` API, using Windows DPAPI hardware-backed encryption or macOS Keychain.
     - Stored locally inside `userData/credentials.vault` with AES-256-GCM.
     - Fail-safe design: if OS-level encryption is unavailable, the vault explicitly refuses to fall back to insecure or predictable keys, propagating a clear error to the UI.
     - Plaintext keys never touch renderer process state or IPC broadcasts.
   - **Web Environment (Ephemeral In-Memory Vault)**:
     - When running in browser preview / web mode, API keys are held strictly in ephemeral JavaScript heap memory (`inMemoryVaultKeys`).
     - Keys are **NEVER** stored in browser `localStorage`, `sessionStorage`, or cookies.
     - Reloading or closing the tab instantly zeroes all key material.
     - Web UI prominently indicates that keys are ephemeral, advising users to run the desktop application for persistent DPAPI security.

5. **Strict Electron Sandbox & IPC Security**:
   - `sandbox: true` is enforced across all browser windows.
   - `contextIsolation: true` is enforced across all browser windows.
   - `nodeIntegration: false` is enforced across all browser windows.
   - **Navigation & Window Open Lockdown**:
     - `will-navigate` listeners intercept and deny navigation to any untrusted external URLs.
     - `setWindowOpenHandler` denies all window creation (`action: 'deny'`).
   - **IPC Origin Validation**:
     - All IPC message handlers parse and validate `senderFrame.url` using strict `URL` parsing.
     - Development URLs must match `http://localhost:5173` or `http://127.0.0.1:5173` exactly.
     - Production URLs must match the normalized file path of the trusted `dist/index.html`.
     - Substring matches (e.g. `startsWith` or `includes`) are strictly disallowed.
   - **Vite Server Isolation**:
     - Development server binds strictly to `localhost:5173` (no `0.0.0.0` or open network binding).
   - **Content Security Policy (CSP)**:
     - Strict CSP meta tags are enforced in `index.html`, restricting script execution and network destinations.

6. **Local Knowledge Isolation & Data Purge**:
   - Documents indexed into the knowledge base are stored within the application's local user data folder.
   - Embeddings and chunks are isolated per workspace/session and never sent to external servers except as necessary context chunks in explicit user queries.
   - **One-Click Comprehensive Purge (`purgeAllData`)**:
     - Instantly wipes all archived session JSON files, active transcripts, cached knowledge documents, and in-memory credential keys with zero residue.
