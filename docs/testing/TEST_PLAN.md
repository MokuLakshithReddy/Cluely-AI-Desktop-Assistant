# Verification & Test Plan

## 1. Test Strategy & Scope
To ensure strict functional equivalence, clean-room integrity, and real-world desktop reliability, testing is structured across 5 distinct tiers:
1. **Unit Tests**: Pure business logic (resampling, RMS + ZCR speech detection, aspect ratio scaling, token budgeting, prompt construction, security checks).
2. **Integration Tests**: Inter-process communication (IPC dispatch, origin verification, whitelist state patching, window coordinate calculations, safeStorage vault operations).
3. **Hardware / Perception Tests**: Display capture thumbnail verification, system audio loopback capture, microphone stream capture.
4. **Security & Sandbox Tests**: Origin header validation, context isolation verification, safeStorage vault encryption, data retention enforcement, session isolation.
5. **End-to-End Acceptance Tests**: Full session lifecycle from launch, screen question asking, live speech transcription, to session termination, archiving, and export.

---

## 2. Test Suite Matrix

| Test Suite | File | Focus Areas | Automated / Manual |
|---|---|---|---|
| **Audio & VAD** | `tests/audio-vad.test.ts` | 48kHz to 16kHz resampling, RMS energy + ZCR speech detection, dynamic noise floor, crosstalk suppression, WAV encoding | Automated (Vitest) |
| **Screen Capture** | `tests/screen-capture.test.ts` | Aspect-ratio downscaling logic, max-1920 clamp, 4K/ultrawide preservation, PNG buffer validation | Automated (Vitest) |
| **AI Context Assembly** | `tests/ai-context.test.ts` | Dual-speaker tagging ([You]/[Speaker]), 5 operating mode guidance, RAG grounding, error filtering | Automated (Vitest) |
| **Knowledge RAG** | `tests/knowledge-rag.test.ts` | PDF text extraction, document ingestion, overlapping chunking, TF-IDF / BM25 ranking relevance | Automated (Vitest) |
| **IPC & Security** | `tests/ipc-security.test.ts` | Sender frame origin verification, untrusted frame rejection, patch whitelist sanitization, injection rejection | Automated (Vitest) |
| **Credential Vault** | `tests/credential-vault.test.ts` | safeStorage OS keyring / AES-256-GCM encryption, boolean key masking, deletion, input validation | Automated (Vitest) |
| **Session Archive** | `tests/session-archive.test.ts` | Multi-session persistence, chronological index, query by ID, single/bulk deletion | Automated (Vitest) |
| **AI Streaming** | `tests/ai-streaming.test.ts` | Non-destructive token accumulation, multi-turn history preservation, abort cancellation, immutability | Automated (Vitest) |
| **Desktop Runtime** | `tests/electron-smoke.cjs` | Window coordinator initialization, IPC router registration, safeStorage binding, clean shutdown | Automated (Electron/Node) |

---

## 3. Acceptance Criteria Checklist (Section 10)
- [x] **Desktop experience**: The app launches, the floating panel works, shortcuts respond, and sessions can be stopped cleanly.
- [x] **Real AI responses**: The application calls a configured model (Gemini, GPT-4o, Claude 3.5, Ollama), streams actual responses without token loss, and handles failures and cancellation.
- [x] **Screen understanding**: A real captured image is sent to a vision-capable service, and the answer reflects its contents.
- [x] **Live transcription**: Dual-stream audio is captured (mic `me` via getUserMedia, system audio `them` via getDisplayMedia loopback) and converted to real text with incremental updates.
- [x] **Conversation context**: Responses use relevant recent context, dual-speaker tags, and do not mix unrelated sessions.
- [x] **Session lifecycle**: Pause, resume, stop, cleanup, and multi-session archive/export behavior work in the running app.
- [x] **Security**: Credentials are encrypted in an OS-backed vault (`safeStorage` / AES-256-GCM), sensitive keys are stripped from shared state, and strict IPC origin validation is enforced.
- [x] **Reliability**: Tests cover interruptions, network failures, missing credentials, malformed inputs, and recovery.
- [x] **Release readiness**: A packaged build compiles successfully (`npm run build`) and passes documented smoke tests.
