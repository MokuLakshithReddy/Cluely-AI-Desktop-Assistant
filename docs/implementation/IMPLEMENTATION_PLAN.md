# Implementation Plan: Cluely Reverse-Engineered Desktop Assistant

## Project Overview
Build an independent, clean-room desktop AI assistant combining real-time screen understanding, live dual-channel conversation transcription, floating assistant overlay with anti-capture stealth, and contextual AI reasoning.

---

## Stage Breakdown & Milestones

### Stage 01: Investigation & Specification (Foundation)
- [x] Extract and inspect Cluely target binary and ASAR bundle (`Cluely Setup 2.0.195.exe`, `app.asar`).
- [x] Run REA (`rea-agents analyze-javascript-application`) and record verifiable Evidence bundle (`ev_3f579700396e22cdcbce959e9489a2654a013788e6c20143a4653533e58d23d9`).
- [x] Document internal domain modules (`constants`, `dock`, `login`, `lifecycle`, `native-audio`, `session`, `shortcuts`, `tray`, `state`, `permissions`, `screenshot`, `ipc`).
- [x] Document IPC channels, audio pipeline (`sox`/`audiotee`, Silero VAD, loopback capture), and screenshot pipeline.
- [x] Establish technical specifications and documentation suite in `docs/`.

### Stage 02: Desktop Foundation
- [ ] Initialize Electron + TypeScript + Vite + React + Tailwind CSS project in `app/`.
- [ ] Implement Window Manager:
  - Frameless floating control pill (`alwaysOnTop`, transparent, draggable).
  - Expandable/collapsible docked chat panel.
  - Full-featured Dashboard window for settings, history, and knowledge.
- [ ] Implement `setContentProtection` toggle for screen-sharing stealth (`WDA_EXCLUDEFROMCAPTURE`).
- [ ] Implement Global Shortcut Manager (toggle visibility, quick ask, session toggle, directional nudge).
- [ ] Implement System Tray with status icon and context menu.
- [ ] Implement secure IPC bridge with typed handlers and sender-origin validation.

### Stage 03: Working AI Assistant
- [ ] Implement multi-provider AI reasoning adapter:
  - Google Gemini (Gemini 2.0 Flash / 1.5 Flash & Pro via direct REST/SDK).
  - OpenAI (GPT-4o, GPT-4o-mini).
  - Anthropic (Claude 3.5 Sonnet).
  - Local Ollama fallback.
- [ ] Implement token-by-token streaming responses with Server-Sent Events / streaming reader.
- [ ] Implement cancellation, retry, and connection error recovery.
- [ ] Integrate Markdown renderer with code syntax highlighting, KaTeX math, and copy controls.
- [ ] Create specialized assistance modes (Interview Copilot, Coding & Debugging, Sales & Negotiation, General Assistant).

### Stage 04: Screen Understanding
- [ ] Implement native screen capture via Electron `desktopCapturer.getSources`.
- [ ] Implement display matching: capture display where floating pill is currently positioned.
- [ ] Implement intelligent downscaling: scale images with max dimension > 1920px while preserving aspect ratio.
- [ ] Connect captured screenshot to multimodal vision LLM pipeline.
- [ ] Add visual feedback (snapshot thumbnail preview in chat input, capture indicator).
- [ ] Support region/screen selection and error handling for inaccessible displays.

### Stage 05: Live Conversation Intelligence
- [ ] Implement dual-channel audio ingestion:
  - Channel A: Microphone audio via Web Audio API.
  - Channel B: Windows system audio loopback via Electron display media handler.
- [ ] Implement Voice Activity Detection (VAD):
  - Silero VAD / Energy VAD running at 16kHz.
  - SpeechStart, SpeechEnd, and VADMisfire state machine with 300ms redemption.
- [ ] Implement crosstalk / echo suppression: zero mic input when system audio is active.
- [ ] Implement Speech-to-Text adapter:
  - Fast Cloud STT (Groq Whisper, OpenAI Whisper, Deepgram Nova-2).
  - Fallback Web Speech API.
- [ ] Render live transcript timeline in chat window with speaker attribution (`me` vs `them`) and timestamps.

### Stage 06: Memory, Knowledge & Session Management
- [ ] Implement Session Lifecycle:
  - Start Session, Pause Capture, Resume Capture, End Session.
  - Active capture indicators (pulsing mic/screen status).
- [ ] Implement Personal Knowledge Base (RAG):
  - Import documents (Markdown, TXT, PDF, code files).
  - Client-side chunking and semantic/keyword retrieval.
  - Grounded answer generation with source references.
- [ ] Implement Session History & Local Persistence:
  - Save session transcripts, Q&A history, and generated meeting summaries.
  - Full data export (Markdown / JSON) and one-click data wipe.

### Stage 07: Testing, Hardening & Release
- [ ] Build unit and integration test suites:
  - Electron IPC and state synchronization tests.
  - Screen capture downscaling and encoding tests.
  - Audio resampler and VAD state machine tests.
  - Multi-provider AI streaming tests.
  - Security and origin validation tests.
- [ ] Run end-to-end smoke tests on Windows.
- [ ] Package desktop application for Windows using `electron-builder`.
- [ ] Verify release readiness against the Acceptance Checklist (Section 10).

