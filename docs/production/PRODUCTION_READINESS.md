# Production Readiness Assessment

**Assessment date:** 2026-11-17 (Asia/Kolkata)  
**Audited main revision:** [`94acb0a`](https://github.com/MokuLakshithReddy/Scandium-Assistant/commit/94acb0a5286af7c4c065df27bcc877d9917b9c6f)  
**Baseline CI evidence:** [main run #237](https://github.com/MokuLakshithReddy/Scandium-Assistant/actions/runs/44124029254)  
**Remediation CI evidence:** [PR #78 run #243](https://github.com/MokuLakshithReddy/Scandium-Assistant/actions/runs/44134523573)  
**Current branch CI:** [PR #78 run #250](https://github.com/MokuLakshithReddy/Scandium-Assistant/actions/runs/44140663069) — source verification and production npm audit passed; three platform packaging jobs are still running  
**Remediation branch:** [fix/portable-python-runtime-and-packaging](https://github.com/MokuLakshithReddy/Scandium-Assistant/tree/fix/portable-python-runtime-and-packaging)

## Status

**NO-GO for production distribution.** Main-branch run #237 failed all three native packaging jobs. The remediation branch's earlier CI run #243 successfully built and launch-tested the Windows portable executable, macOS DMG, and Linux AppImage, including real RealtimeSTT inference. The latest corrected head, PR run #250, has passed source verification, the generated test report, and the production dependency audit; its three native packaging jobs are still in progress. Keep release blocked until run #250 completes its packaged launch tests and the physical-device campaign is signed off.

The known baseline failures were:

| Platform | Baseline failure | Result |
|---|---|---|
| Windows | Bundled runtime did not contain the RealtimeSTT site-packages; isolated import raised `ModuleNotFoundError` | Packaging stopped before installer creation |
| Linux | PyAudio could not compile because `portaudio.h` was missing | Packaging stopped before installer creation |
| macOS | PyAudio could not compile because `portaudio.h` was missing | Packaging stopped before installer creation |

The remediation branch replaces runner-derived Python copies with a checksum-pinned CPython standalone distribution, installs dependencies into that distribution, bundles the PortAudio runtime where needed, and runs real external-audio RealtimeSTT inference. PR #78 CI run #243 completed successfully on Windows, macOS, and Linux: all three platform runtime-provisioning checks, real-audio transcription checks, distributable builds, and packaged Electron launch/shutdown smoke tests passed. This validates the hosted build matrix; it does not replace physical device acceptance.

## What CI has actually verified

| Area | Evidence | Scope and limitation |
|---|---|---|
| JavaScript dependency audit | PR #78 run #250: `npm audit --omit=dev` reports 0 vulnerabilities; full workspace report records 18 high `picomatch` development-tooling findings | Production dependency audit passed; full development/build tree remains under an explicit upstream-patch exception and is not audit-clean |
| TypeScript and lint | Run #237: `npm run lint` passed | Static checks only |
| Unit and integration tests | PR #78 run #250: 249 Vitest tests passed; Electron UI/IPC smoke passed | Includes mocks, synthetic fixtures, and simulated inputs |
| Electron development smoke | PR #78 run #250: 1 Electron UI/preload/IPC smoke passed | Not the packaged runtime |
| Python sidecar protocol tests | PR #78 run #250 protocol step passed (12 tests, 1 legacy test skipped); separate bundled-runtime inference passed in run #243 on all three platforms | The skipped protocol test is not the real packaged inference test; the package jobs run a separate actual STT transcription check |
| Windows packaged application | PR #78 run #243 | Portable executable built; real RealtimeSTT fixture transcription and packaged renderer/preload/IPC smoke passed |
| macOS packaged application | PR #78 run #243 | DMG built; real RealtimeSTT fixture transcription and packaged renderer/preload/IPC smoke passed |
| Linux packaged application | PR #78 run #243 | AppImage built; real RealtimeSTT fixture transcription and packaged renderer/preload/IPC smoke passed |
| Physical-device campaign | Incomplete | The checked-in Windows snapshot is not the required 40-case campaign across claimed OS targets |

## Source-level automated verification status (PR #78 Windows CI run #250)

**250/250 automated checks passing (249/249 Vitest tests + 1/1 Electron UI/preload/IPC E2E smoke test) with 100% pass rate**

The test suite consists of **250 automated checks** across 25 test files (24 Vitest suites + 1 Electron UI/preload/IPC E2E smoke runner).

- `npm test — 249 automated tests across 24 suites
- `npm run test:report — 250 total checks: 249 Vitest + 1 Electron E2E smoke

The following breakdown is regenerated from Vitest and Electron smoke evidence. Its counts are not a permanent product-quality or production-readiness claim.

```text
============================== TEST EXECUTION BREAKDOWN ==============================
1.  tests/audio-ownership.test.ts        3 passed (Dual-Channel Audio Ownership and Capture Lifecycle)
2.  tests/audio-vad.test.ts              10 passed (Audio Processing, VAD & Crosstalk Subsystem)
3.  tests/credential-vault.test.ts       14 passed (Credential Vault & Secret Protection Subsystem)
4.  tests/device-evidence-validator.test.ts 13 passed (device evidence campaign validator)
5.  tests/e2e-desktop-session.test.ts    6 passed (Synthetic Desktop Data-Pipeline Integration (Mocked Hardware/Provider Inputs))
6.  tests/entitlements.test.ts           6 passed (Commercial Subscription & Entitlements Matrix)
7.  tests/hardware-detector.test.ts      6 passed (Hardware Compatibility Subsystem & Model Recommendation)
8.  tests/ipc-security.test.ts           35 passed (IPC Security & Origin Validation Subsystem)
9.  tests/knowledge-rag.test.ts          12 passed (Knowledge Base & Document Retrieval (RAG) Subsystem)
10.  tests/license-manager.test.ts        11 passed (Lemon Squeezy Licensing & Offline Grace Subsystem)
11.  tests/provider-models.test.ts        7 passed (AI Provider Model Propagation and Multi-Turn Serialization)
12.  tests/realtime-stt.test.ts           12 passed (RealtimeSTT Local Speech-to-Text Subsystem ($0 Cost Local STT))
13.  tests/security-redaction.test.ts     46 passed (Security, Privacy & Sensitive-Content Hardening Subsystem)
14.  tests/session-archive.test.ts        12 passed (Multi-Session Archive & Persistence Subsystem)
15.  tests/state-broadcast.test.ts        2 passed (Shared-state renderer broadcast)
16.  tests/state-persistence.test.ts      8 passed (State persistence error reporting)
17.  tests/subscription-url.test.ts       1 passed (First-party subscription page URLs)
18.  tests/whisper-runtime.test.ts        7 passed (Local Speech Recognition (whisper.cpp) Subsystem)
19.  tests/window-coordinator.test.ts     6 passed (Window close recovery, macOS reinitialization & listener idempotency)
20.  tests/ai-context.test.ts             14 passed (AI Context Synthesis & Multimodal Provider Subsystem)
21.  tests/dashboard-routing.test.ts      4 passed (Dashboard Route and Hash Parsing)
22.  tests/web-bridge.test.ts             5 passed (WebBridge Security and Memory Architecture)
23.  tests/ai-streaming.test.ts           4 passed (AI Streaming State Resilience Subsystem)
24.  tests/screen-capture.test.ts         5 passed (Screen Capture & Thumbnail Scaling Subsystem)
25.  tests/electron-smoke.cjs         1/1 passed (Electron Dashboard UI/IPC E2E, native purge, persistence & normal process exit)
--------------------------------------------------------------------------------------
Subtotal (Vitest Test Suites):      249 passing unit & integration tests
Grand Total:                        250 passing checks / 250 total (100% Pass Rate)
======================================================================================
```

Main-branch run #237 never reached native packaging. PR #78 run #243 later passed all three platform packaged-app launch checks. The updated head's rerun #250 has passed source verification and is currently repeating the Windows, macOS, and Linux package/smoke matrix.

## Dependency security status

The main baseline run #237 previously reported a clean npm audit, but the advisory database has since added high-severity [GHSA-fc5q-39xc-vjpf / CVE-2026-112366](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) affecting `picomatch` through 4.0.7. The full-workspace audit reports 18 high-severity findings through development/build-tooling dependency paths. PR #78 run #250 now enforces `npm audit --omit=dev` and reports 0 vulnerabilities in the production dependency graph, while retaining the full audit report with 18 high findings. The upstream remediation proposal [picomatch PR #237](https://github.com/micromatch/picomatch/pull/237) remains open; there is no validated patched release in the current lockfile.

`picomatch` is not a direct app production dependency; it is reached through tooling paths including `tailwindcss`, `chokidar`, and glob/build utilities. The branch CI now retains the full audit report and enforces `npm audit --omit=dev` as a blocking check on the production dependency graph. That production-only audit must pass before merge. Until a patched upstream picomatch release is available, do not claim the entire dependency tree is audit-clean or suppress the full-tree finding.

## Release gates and operational status

1. **Real-device validation — INCOMPLETE:** `docs/testing/DEVICE_EVIDENCE_RUN.json` is a Windows host snapshot. It is not a signed campaign with all required test IDs, per-test evidence, packaged artifact hashes, and coverage for each claimed platform. Do not describe it as production hardware acceptance.
2. **Native release packaging — CI VALIDATED IN PR #78:** All Windows/macOS/Linux package jobs and their packaged smoke tests passed in run #243. Merge the reviewed remediation to main and require the same checks on the resulting main commit before publishing.
3. **Real RealtimeSTT inference — PASSED IN PR #78 RUN #243:** Each platform's bundled runtime transcribed the checked-in JFK audio fixture with CPU INT8 RealtimeSTT. This verifies model loading and external-PCM inference; it is not a physical loopback-device, microphone-permission, or live-meeting acceptance test.
4. **Development-tooling advisory — OPEN:** The full npm tree currently reports the picomatch ReDoS advisory in development/build dependencies. The branch enforces a separate production dependency audit, but the full build-toolchain advisory remains recorded pending an upstream patch and re-audit.
5. **Branch protection — DISABLED:** The main branch currently has no required status checks. Enable required CI checks before merging a release candidate.

## Important implementation facts

- Local state and multi-session archives are unconditionally encrypted at rest with authenticated AES-256-GCM envelopes backed by OS `safeStorage`.
- Migration of legacy unencrypted files is fail-closed: if re-encryption fails on disk, in-memory state is immediately purged to defaults and the `SessionRepository` enters a locked state (`isLocked = true`) prohibiting subsequent session access.
- Cloud screenshot egress policy: When `redactSensitiveData` is active, transmitting desktop screenshots to third-party cloud providers is blocked under fail-closed security policy until certified pixel-level OCR coordinate detection is integrated. Offline inference via Local Ollama processes screenshots locally on-device.
- Microphone and system-loopback audio use independent VAD pipelines. The implementation preserves overlapping speech; it does not intentionally mute local speech when remote speech is active.
- Unexpected microphone or system-loopback track termination now triggers coordinated fail-closed capture shutdown, closes both audio contexts, resets VAD state, and surfaces an error; synthetic Electron E2E coverage was added in PR #63.
- The production credential path uses Electron `safeStorage`. The AES-256-GCM branch in `CredentialVault` is available only when an explicit test key is injected; it is not a production fallback.
- The credential vault uses Electron's asynchronous `safeStorage` APIs. Existing ciphertext from the legacy synchronous API is opened by the asynchronous decryptor; key-rotation results are re-encrypted and persisted under a serialized vault operation queue. The Linux backend allowlist remains fail-closed.
- Data purge removes application-managed session and credential data and stops active capture through the application lifecycle. It is not forensic or physical erasure.
- Electron `setContentProtection` is a platform-provided display-capture mitigation. It cannot guarantee invisibility in every capture tool, OS version, remote desktop path, or external hardware capture setup.

## Required sign-off

A release owner must record the candidate commit, runtime versions, CI run, per-platform packaged launch evidence, device matrix results, signing/notarization checks, checksums, supported OS versions, known limitations, and release URL.

Until the applicable real-device and signed-release gates above are complete, the status remains **NO-GO**.
