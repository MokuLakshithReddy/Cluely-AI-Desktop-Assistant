# Production Readiness Assessment

**Assessment date:** 2026-11-18 (Asia/Kolkata)  
**Audited `main` baseline:** [`333d3de`](https://github.com/MokuLakshithReddy/Scandium-Assistant/commit/333d3de668b024cd407e2cb63aae2bead24103fa)  
**Latest verified `main` CI:** [CI Verification Suite (run #269)](https://github.com/MokuLakshithReddy/Scandium-Assistant/actions/runs/44315105466) — **PASSED** across `Build & Verify (Windows)`, `Package Electron (windows-portable)`, `Package Electron (macos-dmg)`, and `Package Electron (linux-appimage)` (including bundled Python + RealtimeSTT real-audio `jfk.wav` inference and packaged Electron smoke tests)

## Status

**CONDITIONALLY READY (code & automated verification) / NO-GO for public customer release until external release gates complete.**

All confirmed code-level production blockers (including the Whisper `-otxt` leak, Whisper abort/purge cleanup race, `RealtimeSTT.deleteModel` path traversal, centralized verified model registry, provider timeouts/secret redaction, WebBridge fail-closed licensing, and transient HTTP 429/5xx license grace preservation) are remediated and covered by automated regression tests. However, **four external/owner-side production gates remain open**:

1. **Physical-device validation campaign is incomplete (Issue #49 — P1 Release Blocker):** `docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json` contains 120 `NOT_RUN` scaffold records (40 test cases × Windows, macOS, Linux) with zero-filled placeholder artifact digests and no detached GPG sign-off (`DEVICE_EVIDENCE_CAMPAIGN.json.asc`). CI validates only schema structure (`--allow-incomplete`); strict release validation fails closed until real physical-device runs (including microphone/loopback permission revocation, live conferencing compatibility across Zoom/Teams/Meet/Discord/OBS, 30-minute stability, and packaged-app runs on Windows, macOS, and Linux) are genuinely executed and GPG-signed.
2. **No signed production release has been published (Issue #50 — P1 Release Blocker):** The published [`v1.0.2`](https://github.com/MokuLakshithReddy/Scandium-Assistant/releases/tag/v1.0.2) GitHub release is an **unsigned prerelease** pointing to an older commit with no `SHA256SUMS.txt.asc`. `.github/workflows/release.yml` fails closed until owner-held GPG, Windows Authenticode, and Apple Developer ID/notarization secrets are configured, package versions are bumped together to `1.0.3`, and a signed `v1.0.3` tag is pushed on the verified `main` sign-off commit.
3. **Paid commercial subscriptions are not configured (Commercial Launch Blocker — Free distribution unaffected):** `app/electron/config/billing-products.ts` intentionally leaves `plus` and `pro` Lemon Squeezy product/variant IDs empty and `website/index.html` keeps checkout buttons disabled until real Lemon Squeezy products/variants and live checkout URLs exist and are tested end-to-end. `app/electron/services/billing-webhook.ts` provides a unit-tested HMAC-SHA256 signature verification and in-memory deduplication **helper module only** — no deployed HTTP webhook receiver or durable persistent deduplication store exists yet. Free distribution (`Scandium Free` local mode) does not depend on paid billing.
4. **Live third-party AI provider verification is partial & upstream dev-only `picomatch` advisory remains open:** Automated provider tests (`provider-models.test.ts`) verify every model in `MODEL_REGISTRY` via **mocked HTTP responses only**; live network testing across advertised Gemini (`v1beta/models/{model}:streamGenerateContent`), OpenAI, Anthropic, and Groq models requires owner/test API credentials (runnable via `npm run test:live-providers --workspace=app`) and remains part of Issue #49 (`E-01`–`E-05`). Production runtime audit (`npm audit --omit=dev`) reports **0 vulnerabilities**; the full dev/build tree retains 18 high-severity upstream `picomatch <=4.0.7` findings ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), no patched version on npm as of 2026-11-18).

## What CI and local verification have actually proven

| Area | Evidence | Scope and limitation |
|---|---|---|
| JavaScript production dependency audit | `npm audit --omit=dev` reports **0 vulnerabilities** (enforced blocking in `ci.yml` and `release.yml`) | Full dev/build tree (`npm audit`) records 18 high `picomatch <=4.0.7` dev-only findings (`GHSA-fc5q-39xc-vjpf`), tracked in `DEPENDENCY_ADVISORY_REVIEW.md` |
| TypeScript & build | `npm run lint` (`tsc --noEmit`) and `npm run build` (Vite + Electron) pass | Static checks and bundle compilation |
| Unit & integration tests | 296 Vitest tests across 25 test files | Uses deterministic mocks, synthetic fixtures, real local `whisper-cli` + `jfk.wav` transcription, and local filesystem/crypto checks; mocked HTTP provider tests do **not** replace live provider network tests |
| Electron development smoke | 1 Electron UI/preload/IPC smoke passed (`electron-smoke.cjs`) | Exercises real Electron windows, preload bridge, IPC, credential vault, persistence, purge, and clean exit |
| Python sidecar & real RealtimeSTT inference | `test_sidecar.py` (12 protocol tests) + `test_realtime_inference.py` passed on Windows, macOS, and Linux bundled runtimes in `main` run #269 | Verifies checksum-pinned standalone CPython + PortAudio and CPU INT8 `jfk.wav` inference; does not replace physical microphone/loopback/meeting testing |
| Cross-platform packaged builds & launch smoke | `main` run #269: Windows portable `.exe`, macOS `.dmg`, and Linux `.AppImage` all built and passed `packaged-smoke.cjs` | Unsigned CI validation builds (`forceCodeSigning: false`); not signed/notarized customer installers |
| Signed production release & paid billing | **BLOCKED (Owner secrets & store config pending)** | Signing/notarization/GPG secrets not yet configured; `v1.0.2` is an older unsigned prerelease; `BILLING_PRODUCTS` IDs are empty and checkout is disabled |
| Physical-device 40-case campaign | **INCOMPLETE (Issue #49 open)** | All 3 platforms remain `NOT APPROVED` in `DEVICE_VALIDATION_MATRIX.md` until 40-case runs are completed and GPG-signed |

## Source-level automated verification status (regenerated from local/CI runner output)

**297/297 automated checks passing (296/296 Vitest tests + 1/1 Electron UI/preload/IPC E2E smoke test) with 100% pass rate**

The test suite consists of **297 automated checks** across 26 test files (25 Vitest suites + 1 Electron UI/preload/IPC E2E smoke runner).

- `npm test — 296 automated tests across 25 suites
- `npm run test:report — 297 total checks: 296 Vitest + 1 Electron E2E smoke

The following breakdown is regenerated automatically by `app/scripts/generate-test-report.cjs` from actual Vitest JSON output and Electron smoke exit verification. Its counts are not a substitute for physical-device or signed-release validation.

```text
============================== TEST EXECUTION BREAKDOWN ==============================
1.  tests/audio-ownership.test.ts        3 passed (Dual-Channel Audio Ownership and Capture Lifecycle)
2.  tests/audio-vad.test.ts              10 passed (Audio Processing, VAD & Crosstalk Subsystem)
3.  tests/credential-vault.test.ts       14 passed (Credential Vault & Secret Protection Subsystem)
4.  tests/device-evidence-validator.test.ts 16 passed (device evidence campaign validator)
5.  tests/e2e-desktop-session.test.ts    6 passed (Synthetic Desktop Data-Pipeline Integration (Mocked Hardware/Provider Inputs))
6.  tests/entitlements.test.ts           8 passed (Commercial Subscription & Entitlements Matrix)
7.  tests/hardware-detector.test.ts      7 passed (Hardware Compatibility Subsystem & Model Recommendation)
8.  tests/ipc-security.test.ts           35 passed (IPC Security & Origin Validation Subsystem)
9.  tests/knowledge-rag.test.ts          12 passed (Knowledge Base & Document Retrieval (RAG) Subsystem)
10.  tests/license-manager.test.ts        15 passed (Lemon Squeezy Licensing & Offline Grace Subsystem)
11.  tests/lifecycle-shutdown.test.ts     8 passed (Lifecycle Shutdown Coordinator & Application Lifecycle Guarantees)
12.  tests/provider-models.test.ts        14 passed (AI Provider Model Propagation and Multi-Turn Serialization)
13.  tests/realtime-stt.test.ts           19 passed (RealtimeSTT Local Speech-to-Text Subsystem ($0 Cost Local STT))
14.  tests/security-redaction.test.ts     46 passed (Security, Privacy & Sensitive-Content Hardening Subsystem)
15.  tests/session-archive.test.ts        12 passed (Multi-Session Archive & Persistence Subsystem)
16.  tests/state-broadcast.test.ts        2 passed (Shared-state renderer broadcast)
17.  tests/state-persistence.test.ts      8 passed (State persistence error reporting)
18.  tests/subscription-url.test.ts       1 passed (First-party subscription page URLs)
19.  tests/web-bridge.test.ts             6 passed (WebBridge Security and Memory Architecture)
20.  tests/whisper-runtime.test.ts        19 passed (Local Speech Recognition (whisper.cpp) Subsystem)
21.  tests/window-coordinator.test.ts     6 passed (Window close recovery, macOS reinitialization & listener idempotency)
22.  tests/ai-context.test.ts             14 passed (AI Context Synthesis & Multimodal Provider Subsystem)
23.  tests/ai-streaming.test.ts           4 passed (AI Streaming State Resilience Subsystem)
24.  tests/dashboard-routing.test.ts      5 passed (Dashboard Route and Hash Parsing)
25.  tests/screen-capture.test.ts         6 passed (Screen Capture & Thumbnail Scaling Subsystem)
26.  tests/electron-smoke.cjs         1/1 passed (Electron Dashboard UI/IPC E2E, native purge, persistence & normal process exit)
--------------------------------------------------------------------------------------
Subtotal (Vitest Test Suites):      296 passing unit & integration tests
Grand Total:                        297 passing checks / 297 total (100% Pass Rate)
======================================================================================
```

## Dependency security status

Both `.github/workflows/ci.yml` and `.github/workflows/release.yml` enforce `npm audit --omit=dev` (0 critical, 0 high, 0 moderate, 0 low vulnerabilities in the production dependency graph) while capturing and uploading the full workspace audit report (`npm-audit-full.json`). The full-workspace audit records 18 high-severity findings through development/build-tooling paths for [GHSA-fc5q-39xc-vjpf / CVE-2026-112366](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) affecting `picomatch <=4.0.7` (`tailwindcss`, `chokidar`, `vitest`, `electron-builder` tooling). `picomatch` is not a direct app runtime dependency, and `4.0.7` remains the latest version published on npm as of 2026-11-18. See [`docs/security/DEPENDENCY_ADVISORY_REVIEW.md`](../security/DEPENDENCY_ADVISORY_REVIEW.md).

## Release gates and operational status

1. **Real-device validation — INCOMPLETE (ENFORCED & GPG-SIGNED IN RELEASE PIPELINE):** `docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json` is scaffolded with all 40 test IDs initialized to `NOT_RUN` across Windows, macOS, and Linux (validated structurally in CI via `--allow-incomplete`), and `docs/testing/DEVICE_VALIDATION_MATRIX.md` marks all platforms `NOT APPROVED (INCOMPLETE)`. `.github/workflows/release.yml` requires both a detached GPG signature (`docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json.asc`, verified via `gpg --verify`) and strict validation via `node scripts/validate-device-evidence.cjs docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json --release-commit "$GITHUB_SHA" --expected-version "$tag_version"`. Issue #49 remains open until completed.
2. **Signed production release — BLOCKED:** Published `v1.0.2` is an unsigned prerelease from an older commit without `SHA256SUMS.txt.asc`. `.github/workflows/release.yml` fails closed until GPG, Windows Authenticode, and Apple Developer ID/notarization secrets are configured and a signed `v1.0.3` tag matching current `main` is pushed. Issue #50 remains open as the publication tracker.
3. **Paid subscriptions & checkout — EDGE RECEIVER DEPLOYED, CHECKOUT PENDING (Free distribution unaffected):** A production edge webhook receiver backed by Upstash Redis durable persistent event deduplication (`SET NX` with 7-day TTL) is implemented in `services/billing-webhook/` and deployed at `https://scandium-billing-webhook.mokulakshithreddy.workers.dev/api/webhook/lemonsqueezy` (`/health` reporting healthy). `app/electron/config/billing-products.ts` intentionally leaves `plus` and `pro` product/variant IDs empty, and checkout in `website/index.html` is intentionally disabled until real Lemon Squeezy products are created by the store owner.
4. **Native CI packaging & bundled RealtimeSTT inference — PASSED ON `main` (`333d3de`, run #273):** Windows, macOS, and Linux unsigned validation packages, bundled CPython + PortAudio provisioning, real `jfk.wav` CPU INT8 RealtimeSTT transcription, and packaged Electron smoke tests all passed.
5. **Development-tooling advisory — OPEN UPSTREAM:** Production runtime audit (`npm audit --omit=dev`) reports 0 vulnerabilities; the 18 high `picomatch <=4.0.7` dev/build-tooling findings remain documented pending an upstream patch.
6. **Branch protection — ENABLED ON `main`:** Strict required status checks (`Build & Verify (Windows)`, `Package Electron (windows-portable)`, `Package Electron (macos-dmg)`, `Package Electron (linux-appimage)`) with `enforce_admins: true` and force-push/deletion blocking are active on `main`.

## Important implementation facts

- Local state and multi-session archives are unconditionally encrypted at rest with authenticated AES-256-GCM envelopes backed by OS `safeStorage`.
- Application lifecycle shutdown (`app/electron/domains/lifecycle-shutdown.ts`) coordinates graceful teardown between Electron `before-quit`/`will-quit`, state persistence, RealtimeSTT sidecar termination, and Whisper temp-file cleanup. Shutdown fails closed and prevents normal application exit if audio processes remain active or if temporary files cannot be removed, persists actionable error state to `stateManager`, prevents duplicate concurrent operations via single-flight mutex, and breaks `before-quit` infinite loops.
- Local `whisper.cpp` transcription omits `-otxt` / `--output-txt`, reads transcript output strictly from stdout, isolates temporary WAV files in owner-restricted (`0o700`/`0o600`) PID-tagged directories, waits for child termination and bounded Windows `EBUSY` cleanup retries before settling cancellation/purge/shutdown, and explicitly fails purge if temp removal fails. Overwriting before unlink is best-effort application-level cleanup, not certified forensic erasure on SSDs, flash storage, journaled filesystems, or copy-on-write filesystems.
- AI models are centralized in `app/src/lib/model-registry.ts` (consumed by Dashboard UI, IPC router, state migration, WebBridge, and provider adapters) with verified model IDs, bounded request timeouts, and automatic secret redaction on upstream HTTP errors.
- Data purge removes application-managed session, credential, and temporary Whisper files after stopping active capture/transcription through the application lifecycle. It is logical deletion, not physical/forensic erasure.
- Electron `setContentProtection` is a platform-provided display-capture mitigation and cannot guarantee invisibility across every capture tool, OS version, remote desktop path, or hardware capture device.

## Required sign-off

Until the applicable physical-device (#49) and signed-release (#50) gates above are genuinely completed, public release status remains **NO-GO** (and commercial paid launch additionally requires Lemon Squeezy product/checkout configuration).
