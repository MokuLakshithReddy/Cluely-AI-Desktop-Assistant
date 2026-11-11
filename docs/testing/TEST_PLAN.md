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

The table describes the current checked-in automated suite. Counts are historical evidence and must be confirmed from a fresh run before every release candidate.

| Test Suite | File | Focus Areas | Automated / Manual |
|---|---|---|---|
| Audio & VAD | `tests/audio-vad.test.ts` | Resampling, RMS/ZCR detection, independent source activity, WAV encoding | Automated (Vitest) |
| Audio Ownership | `tests/audio-ownership.test.ts` | Capture ownership, pending permission cancellation, independent mic/system VAD | Automated (Vitest) |
| Screen Capture | `tests/screen-capture.test.ts` | Thumbnail sizing and proportional scaling | Automated (Vitest); real display capture is manual |
| AI Context Assembly | `tests/ai-context.test.ts` | Prompt construction, transcript speaker labels, operating modes, context filtering | Automated (Vitest) |
| Knowledge Retrieval | `tests/knowledge-rag.test.ts` | PDF.js extraction, ingestion, chunking, TF-IDF lexical retrieval | Automated (Vitest); not embedding/vector retrieval |
| IPC & Security | `tests/ipc-security.test.ts` | Sender-frame origin checks, request identity, schema and size validation | Automated (Vitest) |
| Credential Vault | `tests/credential-vault.test.ts` | Async safeStorage, legacy ciphertext, key rotation, serialization | Automated (Vitest); OS backend coverage is platform-dependent |
| Session Archive | `tests/session-archive.test.ts` | Persistence, path containment, screenshot stripping, size limits | Automated (Vitest); archive files are currently not encrypted at rest |
| AI Streaming | `tests/ai-streaming.test.ts` | Token accumulation, history preservation, abort behavior | Automated (Vitest) |
| Dashboard Routing | `tests/dashboard-routing.test.ts` | Route hash and sub-tab routing | Automated (Vitest) |
| Provider Models | `tests/provider-models.test.ts` | Provider/model routing and serialization | Automated (Vitest); live provider availability is not established |
| Web Bridge | `tests/web-bridge.test.ts` | In-memory web credentials and cancellation scoping | Automated (Vitest) |
| Synthetic Pipeline Integration | `tests/e2e-desktop-session.test.ts` | Synthetic audio, scaling, knowledge retrieval, mocked streaming, session persistence | Automated (Vitest); not a physical-device E2E |
| Electron UI/IPC Smoke | `tests/electron-e2e.cjs`, `tests/electron-smoke.cjs` | Dashboard, preload, IPC, persistence, purge and controlled shutdown | Automated (Electron) |
| Packaged App Smoke | `tests/packaged-smoke.cjs` | Launch actual Windows portable, macOS app, and Linux AppImage; renderer/preload/IPC readiness and clean shutdown | Native CI runners; not physical-device capture acceptance |
| Device Acceptance | `docs/testing/DEVICE_VALIDATION_MATRIX.md` | Microphone, system audio, display permissions, live providers, emergency stop/purge, stability and conferencing compatibility | Manual on physical devices; issue #49 remains open |

The last documented successful baseline recorded 124 Vitest checks plus one Electron UI/IPC smoke check (125 total) and separately completed native packaged-app smoke. See [TEST_RESULTS.md](TEST_RESULTS.md). This is historical evidence, not a current-head pass. The current `main` CI run failed before any job step executed because GitHub did not allocate a runner; re-run CI before using any count as a release result.


---

## 3. Verification Environments Matrix

Automated CI targets Windows, macOS, and Linux package creation/launch smoke jobs. The exact runner images and runtime versions must be read from the workflow run for each candidate; do not retain old Node.js 20, Electron 34, or Vitest 3 details as current environment claims.

A successful package launch smoke verifies the packaged renderer/preload/IPC path and controlled shutdown. It does not verify physical microphone devices, OS loopback, display permissions, meeting-app compatibility, live cloud-provider behavior, or long-duration stability on end-user hardware.

Physical-device acceptance is recorded separately in [DEVICE_VALIDATION_MATRIX.md](DEVICE_VALIDATION_MATRIX.md). As of November 11, 2026, the matrix still marks device configurations NOT RUN / NOT APPROVED and issue [#49](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/49) remains open.


---

## 4. Acceptance Criteria Checklist

### Automated evidence
- [x] Unit and integration test suites are checked into the repository.
- [x] Electron UI/preload/IPC smoke exercises Dashboard, persistence, purge, and controlled shutdown.
- [x] Native CI package smoke launches Windows, macOS, and Linux artifacts in the documented successful baseline.
- [ ] Current `main` head has a successful CI run; the latest run failed before runner allocation.
- [ ] Current PR changes have a successful CI run; their Windows jobs are currently failing before any steps execute.

### Manual release acceptance
- [ ] Physical microphone grant/denial/revocation/disconnect and reselection tests pass on each claimed OS/device configuration.
- [ ] System-audio loopback and simultaneous local/remote speech pass on each claimed OS/session type.
- [ ] Display-capture permission, cancellation, revocation, and multi-monitor tests pass.
- [ ] Emergency stop and purge pass with real devices and live transcription/provider work.
- [ ] Live provider credentials, model availability, rate limits, network failure, cancellation, and recovery are verified.
- [ ] Conference/screen-recorder compatibility and long-session stability are recorded.
- [ ] Session archives and shared conversation/knowledge state are encrypted at rest with a tested legacy migration; tracked by [issue #73](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/73).
- [ ] Windows/macOS signing, notarization, GPG tag/checksum verification, and signed v1.0.2 publication are completed.

Do not mark a manual criterion complete based on synthetic media, mocked permissions, package launch smoke, or documentation alone. The repository remains **NO-GO** until the applicable physical-device and signed-release gates are complete.
