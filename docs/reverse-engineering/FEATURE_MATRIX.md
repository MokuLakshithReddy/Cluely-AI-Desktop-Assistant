# Cluely Copilot Feature Matrix: Source-Verified Implementation Status

This matrix describes the independent implementation in `app/`, not capabilities observed in the original Cluely application. Statuses are based on the current repository source and automated tests as of the revision containing this document.

**Verification boundary:** “Implemented” means the relevant behavior exists in this source tree. It does not imply physical-device, OS-permission, conferencing-app, or live-provider validation. Those require the real-device matrix in [DEVICE_VALIDATION_MATRIX.md](../testing/DEVICE_VALIDATION_MATRIX.md).

| Category | Capability | Current implementation | Status / limitation |
|---|---|---|---|
| Desktop shell | Floating control window | Electron frameless, transparent, always-on-top control window; source dimensions are 490 × 56 | Implemented; packaged launch is CI-tested |
| Desktop shell | Chat window | Separate resizable Electron window positioned beneath the control window | Implemented; packaged launch is CI-tested |
| Desktop shell | Dashboard | Separate settings, credentials, knowledge, shortcuts, and session-history window | Implemented; UI/IPC smoke-tested |
| Desktop shell | System tray | No Electron Tray implementation is present in the reviewed source | Not implemented |
| Desktop shell | Global shortcuts | Configurable global accelerators for visibility, ask, clear, emergency stop, session toggle, and window movement | Implemented; registration-conflict UX and real desktop conflict testing are not established |
| Desktop shell | Window recovery | Recreates control/chat windows on supported lifecycle events and avoids duplicate state subscriptions | Implemented; automated lifecycle tests exist |
| Desktop shell | Display content protection | Calls Electron `setContentProtection` when stealth mode is enabled | Best-effort OS feature; never claim universal invisibility |
| Audio | Local microphone capture | Renderer requests microphone access with `getUserMedia`; Web Audio `ScriptProcessorNode` processes 48 kHz input | Implemented in source; real microphone/permission matrix pending |
| Audio | System-audio loopback | Electron `setDisplayMediaRequestHandler` grants a screen source with `audio: 'loopback'` while recording is active | Implemented in source; do not infer identical support across Windows, macOS, and Linux; physical validation pending |
| Audio | Dual-source attribution | Microphone and system-loopback use separate streams, resamplers, VAD processors, and transcript roles | Implemented in source; synthetic independent-VAD coverage exists |
| Audio | VAD algorithm | Adaptive RMS energy threshold plus zero-crossing-rate discrimination, with pre-speech buffering, silence redemption, and a 20-second segment cap | Implemented; this is not Silero or ONNX VAD |
| Audio | Crosstalk suppression | No production rule suppresses microphone samples when remote VAD is active; independent sources are retained | Not implemented; do not claim speaker arbitration or echo cancellation beyond browser/device microphone constraints |
| Audio | Speech-to-text | Groq Whisper and OpenAI transcription endpoints are supported through the main-process IPC bridge | Implemented in source; live provider and device tests pending; no Deepgram/Web Speech adapter is present |
| Screen | Screenshot capture | Main process captures the display matching the control window, falls back to primary display, and downsizes to a 1920 px maximum dimension | Implemented in source; real permission/display matrix pending |
| AI | Provider adapters | Gemini, OpenAI, Anthropic, and local Ollama request adapters | Implemented in source; exact model/account availability is not guaranteed |
| AI | Streaming | SSE parsing for cloud providers and newline-delimited JSON streaming for Ollama | Implemented; provider-specific live streaming validation pending |
| AI | Assistance modes | Copilot, interview, coding, sales, and executive prompt presets | Implemented in source |
| AI | Context assembly | User query, recent completed transcript, conversation history, screenshot, and retrieved knowledge passages | Implemented in source |
| Knowledge | File ingestion | PDF.js text extraction plus text/Markdown/JSON/source-file ingestion; per-file input limit is 2 MiB | Implemented in source; document-specific compatibility still needs broader fixtures |
| Knowledge | Retrieval | Local TF-IDF lexical ranking over overlapping character-based chunks | Implemented; this is not embedding-based semantic or vector search |
| Sessions | Local archive | Main-process JSON session repository with identifier validation and path-containment checks | Implemented; automated persistence tests exist |
| Sessions | Screenshot retention | Screenshot payloads are stripped from saved session messages | Implemented in state and repository serialization paths |
| Privacy | Emergency stop | Global shortcut stops capture state and aborts active AI/STT operations; renderer capture hook tears down media resources | Implemented in source; real-device behavior still pending |
| Privacy | Data purge | Closes write gate, aborts active work, deletes app-managed credentials/session archives, and clears active state | Implemented as application-level logical deletion; not forensic erasure; physical-device race validation pending |
| Security | Renderer isolation | BrowserWindows use context isolation, disabled Node integration, sandboxing, restricted preload bridge, and navigation/window-open guards | Implemented in source; continue reviewing every new IPC method |
| Security | IPC validation | Exact trusted-origin checks, per-channel validation, nested payload schemas, and aggregate size limits | Implemented; automated negative-path tests exist |
| Security | Credential storage | Async Electron `safeStorage` APIs; Linux accepts allowlisted Secret Service/KWallet backends and fails closed otherwise | Implemented in source; OS keychain behavior still needs real-device validation |

## Important corrections to earlier claims

- The local VAD is an RMS/ZCR implementation, not Silero VAD or ONNX Runtime.
- The two capture sources have independent VAD pipelines. The code does not intentionally zero local microphone audio during remote speech.
- The current STT adapters are Groq and OpenAI. Do not advertise Deepgram or browser-native speech recognition as implemented.
- Knowledge retrieval is TF-IDF lexical ranking, not vector search or embedding-based semantic retrieval.
- The AES-256-GCM vault branch is only available to tests when an explicit test key is injected. Production credential storage does not silently fall back to application-managed AES.
- CI package smoke tests and synthetic media tests do not complete the physical-device validation gate.
