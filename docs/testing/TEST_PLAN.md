# Verification & Test Plan

## 1. Test Strategy & Scope
To ensure strict functional equivalence and real-world reliability, testing is structured across 5 distinct tiers:
1. **Unit Tests**: Pure business logic (resampling, VAD transitions, aspect ratio scaling, token budgeting, prompt construction, security checks).
2. **Integration Tests**: Inter-process communication (IPC dispatch, state patching, window coordinate calculations, provider adapters).
3. **Hardware / Perception Tests**: Display capture thumbnail verification, audio loopback capture, microphone stream capture.
4. **Security & Sandbox Tests**: Origin header validation, context isolation verification, API key redaction, data retention enforcement.
5. **End-to-End Acceptance Tests**: Full session lifecycle from launch, screen question asking, live speech transcription, to session termination and export.

---

## 2. Test Suite Matrix

| Test Suite | File | Focus Areas | Automated / Manual |
|---|---|---|---|
| **Audio & VAD** | `tests/audio-vad.test.ts` | 48kHz to 16kHz resampling, energy calculation, Silero state transitions, crosstalk suppression | Automated (Vitest/Jest) |
| **Screen Capture** | `tests/screen-capture.test.ts` | Aspect-ratio downscaling logic, max-1920 clamp, PNG header validation, empty thumbnail handling | Automated (Vitest/Jest) |
| **AI Providers** | `tests/ai-providers.test.ts` | Gemini, OpenAI, Claude payload formatting, streaming chunk parser, error & retry handling | Automated (Vitest/Jest) |
| **Context Fusion**| `tests/context-fusion.test.ts` | Merging transcript + image + prompt, token limit truncation, grounded missing context response | Automated (Vitest/Jest) |
| **IPC & Security** | `tests/ipc-security.test.ts` | Origin validation rejection of untrusted frames, typed handler responses, state immutability | Automated (Vitest/Jest) |
| **Knowledge RAG** | `tests/knowledge-rag.test.ts` | Document ingestion, chunking, keyword/cosine retrieval relevance, boundary checks | Automated (Vitest/Jest) |
| **Desktop E2E** | `tests/e2e-smoke.test.ts` | Window creation, floating bar dragging, shortcut triggering, clean exit | Automated / Interactive |

---

## 3. Acceptance Criteria Checklist (Section 10)
- [ ] **Desktop experience**: The app launches, the floating panel works, shortcuts respond, and sessions can be stopped cleanly.
- [ ] **Real AI responses**: The application calls a configured model, streams actual responses, and handles failures and cancellation.
- [ ] **Screen understanding**: A real captured image is sent to a vision-capable service, and the answer reflects its contents.
- [ ] **Live transcription**: Permitted audio is captured and converted to real text with incremental updates.
- [ ] **Conversation context**: Responses use relevant recent context and do not mix unrelated sessions.
- [ ] **Session lifecycle**: Pause, resume, stop, cleanup, and retention behavior work in the running app.
- [ ] **Security**: Credentials are protected, permissions are respected, and privileged operations are isolated.
- [ ] **Reliability**: Tests cover interruptions, network failures, missing credentials, malformed inputs, and recovery.
- [ ] **Release readiness**: A packaged build launches successfully on the target OS and passes documented smoke tests.

