# Real-Device and Operating-System Validation Matrix

**Purpose:** evidence-led validation of microphone, system-audio, screen-capture, permission, provider, privacy-stop, and display-protection behavior on real supported devices.

**Current campaign status:** **INCOMPLETE / NOT APPROVED.** A partial Windows 11 host snapshot (`DEVICE_EVIDENCE_RUN.json`) and local Developer Mode verification exist, but the required 40-case device-evidence campaign validated by `scripts/validate-device-evidence.cjs` has **not** yet been completed for Windows, macOS, or Linux. Synthetic media and mocked Electron tests are not substitutes for the device runs below.

Use [`DEVICE_EVIDENCE_FORMAT.md`](./DEVICE_EVIDENCE_FORMAT.md) for stable per-case IDs, the evidence JSON structure, and the release-owner validation command.

## 1. Release candidate identity

Complete this section for each validation campaign. Do not reuse a result after the app binary or relevant runtime changes.

| Field | Value |
|---|---|
| Release candidate version | `1.0.2` (development baseline — `v1.0.2` is an older unsigned prerelease; next signed production target is `v1.0.3`) |
| Latest verified `main` commit SHA | [`ef87cb0`](https://github.com/MokuLakshithReddy/Scandium-Assistant/commit/ef87cb099a9430bd27f7c2950a67b09e4f1c6dd9) |
| CI workflow run URL | [CI Verification Suite (run #269)](https://github.com/MokuLakshithReddy/Scandium-Assistant/actions/runs/44315105466) |
| Signed production artifact | **NOT YET PRODUCED** (CI artifacts are unsigned validation builds; `v1.0.2` tag points to an older commit and is an unsigned prerelease) |
| Electron version | `45.2.3` |
| Node.js CI version | `24.22.2` |
| Partial Windows host snapshot | [`DEVICE_EVIDENCE_RUN.json`](./DEVICE_EVIDENCE_RUN.json) (7 workstation checks — **not** the 40-case campaign schema) |
| Complete 40-case campaign JSON | **PENDING** (`npm run validate:device-evidence <campaign.json>` not yet passed) |

## 2. Platform and device coverage

Run on a clean user profile with the **signed packaged candidate**, not the development server or unpacked directory.

| Platform | OS release and build | CPU / architecture | App artifact | Microphone device | Audio output / loopback route | Display configuration | Result |
|---|---|---|---|---|---|---|---|
| Windows 10/11 x64 | Windows 11 Build 26200 x64 | Intel Core Ultra 7 256V / x64 | Unpacked local build only (signed packaged exe pending) | Physical array enumerated (partial snapshot only) | WASAPI devices enumerated (full meeting loopback campaign pending) | 1920x1200 @ 1.25x Intel Arc 140V | **INCOMPLETE — NOT APPROVED** |
| macOS supported release | Pending physical device | arm64 | Signed & notarized DMG (pending) | NOT RUN | NOT RUN | NOT RUN | **NOT RUN — NOT APPROVED** |
| Linux supported distribution | Pending physical device | x64 | AppImage (pending) | NOT RUN | NOT RUN | NOT RUN | **NOT RUN — NOT APPROVED** |

Record only OS versions and architectures that are actually tested. Do not infer Apple Silicon, Intel Mac, Wayland, X11, or Linux distribution support from a successful package build on a different runner.

## 3. Required device-backed test cases

Use a fresh application profile and a consented test conversation. Record PASS, FAIL, BLOCKED, or NOT APPLICABLE for each test. Attach logs/screenshots or a short screen recording where permitted; never attach API keys, raw private meeting audio, or other participants' personal data.

### A. Microphone lifecycle and permission handling

1. Grant microphone permission and start capture from the explicit UI control.
2. Confirm the UI capture indicator appears and local voice activity/transcription is attributed to the local speaker.
3. Deny permission on first request. Confirm the app reports a useful error, remains responsive, and does not indicate that capture is active.
4. Revoke permission while the app is running. Confirm capture stops safely and the user can recover after granting permission again.
5. Disconnect or disable the selected microphone while recording. Confirm tracks/VAD stop, an actionable error is shown, and the app does not spin or recreate a session.
6. Change the default input device and repeat the capture test.

### B. System-audio / meeting loopback

1. Start a consented test meeting or play a test speech stream through the output device.
2. Grant all relevant OS display/audio permissions when requested.
3. Confirm remote/system speech is transcribed under the remote speaker role.
4. Speak at the same time as the remote speaker. Confirm both independent VAD pipelines preserve overlapping speech; neither source should be intentionally muted because the other is active.
5. Switch output devices, disconnect a headset, pause/resume the meeting, and end the meeting. Confirm stream teardown/recovery is correct.
6. Repeat on the OS's supported audio path (for example, Windows loopback, macOS screen/system-audio capture path, and the exact Linux desktop/session backend claimed as supported).

Do not report system-loopback support for an OS/session type that has not completed this sequence.

### C. Screen capture and display permissions

1. Grant screen-recording/display-capture permission and request visual context through the documented user action.
2. Confirm the correct display is captured and sent only with the requested AI context.
3. Deny the permission, cancel the selection UI, and revoke permission after a successful capture. Each case must fail safely without showing a fabricated screenshot.
4. Test single-monitor, multiple-monitor, mixed-resolution, portrait, and display hot-plug configurations.
5. Lock/unlock, sleep/wake, and change display scaling; verify capture recovers or reports a clear error.

### D. Emergency stop and purge with live devices

1. Start actual microphone and system-audio capture and produce simultaneous speech.
2. Trigger the dedicated Emergency Stop shortcut while both streams are active.
3. Verify all real media tracks stop, both audio contexts close, VAD activity flags reset, and pending AI/STT operations abort.
4. Start capture again, then invoke Purge while capture and transcription are active.
5. Verify no transcript/session is recreated by late callbacks; archived sessions, knowledge data, and credentials are removed from the application profile.
6. Verify the UI clearly reflects stopped state. Restart the application and confirm the purged records are not restored.

The test must observe real track `readyState` / `ended` behavior and real OS device state, not only mocked function calls or shared-state flags.

### E. Live provider/network behavior

Use dedicated non-production provider test credentials and small test prompts/audio clips.

1. Verify one successful speech-to-text request using each configured STT provider.
2. Verify a successful streaming LLM request for each provider/model combination the release advertises.
3. Test an invalid/revoked key, a model unavailable to the test account, rate limiting (HTTP 429), server error, DNS/network loss, and recovery.
4. Abort during an active token stream and during active transcription. Confirm no further requests/segments are accepted for the aborted operation, previously received chat tokens remain intact, and a subsequent request succeeds.
5. Verify provider credentials are not printed in logs, URLs, renderer state, crash reports, or persisted transcripts.

Provider model availability changes over time; record the exact model identifier, API version, account tier where relevant, and date.

### F. Display protection / conferencing compatibility

For each exact OS build and application version, test the current product's display-protection behavior with the user's normal screen-sharing configuration. Record what was actually observed; do not state blanket invisibility.

| Capture application / path | Version | OS | Protected window excluded? | Notes / limitations |
|---|---|---|---|---|
| Zoom window share | Pending | Windows 11 / macOS / Linux | **NOT RUN** | Requires live conferencing capture test on signed packaged build |
| Microsoft Teams share | Pending | Windows 11 / macOS / Linux | **NOT RUN** | Requires live conferencing capture test on signed packaged build |
| Google Meet tab/window/display share | Pending | Windows 11 / macOS / Linux | **NOT RUN** | Requires live conferencing capture test on signed packaged build |
| Discord screen share | Pending | Windows 11 / macOS / Linux | **NOT RUN** | Requires live conferencing capture test on signed packaged build |
| OBS display capture | Pending | Windows 11 / macOS / Linux | **NOT RUN** | Requires live conferencing capture test; hardware capture cards bypass OS DWM protection |
| OS-native screenshot/recording | Pending | Windows 11 / macOS / Linux | **NOT RUN** | `setContentProtection(true)` API call succeeded without OS error in host snapshot, but live visual exclusion capture has not been recorded in the 40-case campaign |

Also test the control window, chat window, and dashboard independently. Document the known limits of OS-level content protection, remote-desktop capture, admin capture, and external hardware capture.

### G. Stability and lifecycle

1. Run a 30-minute consented audio session and record CPU, memory, and any renderer/main-process errors.
2. Minimize/restore, show/hide chat, open/close dashboard, and change audio devices during the session.
3. Test app restart, OS sleep/wake, and application quit while idle and while capture is active.
4. Confirm there are no orphaned audio tracks, windows, child processes, stuck global shortcuts, or unhandled promise rejections.

## 4. Per-test execution record

Partial Windows 11 local verification recorded to date (not yet a complete 40-case campaign):
- `DEVICE_EVIDENCE_RUN.json` records 7 baseline workstation checks on Windows 11 (DPAPI encryption, display geometry, `setContentProtection(true)` API call, window mount, AES-256-GCM state persistence, credential vault lifecycle, and Windows audio adapter enumeration). It does **not** conform to the 40-case `DEVICE_EVIDENCE_FORMAT.md` campaign schema validated by `scripts/validate-device-evidence.cjs`.
- Local unpackaged Developer Mode verification on Windows 11 confirmed live Gemini BYOK streaming (`gemini-2.5-flash` and `gemini-3.5-flash-lite`), local privacy mode & outbound secret guards, local `whisper.cpp` and `RealtimeSTT + faster-whisper` CPU INT8 transcription of `jfk.wav`, encrypted session archive roundtrip, and Free-tier entitlement enforcement.
- Full 40-case physical-device testing (including real microphone/loopback permission revocation, live conferencing compatibility, 30-minute stability, and signed packaged installer runs on Windows, macOS, and Linux) remains **INCOMPLETE**.

## 5. Release sign-off table

| Platform | Microphone | System audio | Screen capture | Permission denial/revocation | Emergency stop | Purge | Live providers | Packaged app stability | Sign-off |
|---|---|---|---|---|---|---|---|---|---|
| Windows 10/11 x64 | INCOMPLETE | INCOMPLETE | INCOMPLETE | NOT RUN | NOT RUN | PARTIAL (unpacked) | PARTIAL (Gemini unpacked) | NOT RUN (signed pkg pending) | **NOT APPROVED (INCOMPLETE)** |
| macOS supported release | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | **NOT APPROVED (NOT RUN)** |
| Linux claimed distribution(s) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | **NOT APPROVED (NOT RUN)** |

Hosted CI packaging and headless launch smoke tests pass on Windows, macOS, and Linux, but CI runs are **not** substitutes for physical-device sign-off.

## 6. Release gate

The release gate is **BLOCKED — INCOMPLETE** across all platforms, consistent with [`docs/production/PRODUCTION_READINESS.md`](../production/PRODUCTION_READINESS.md). Before approving production distribution:
1. Complete the 40-case campaign JSON for every supported platform on signed packaged builds and verify with `npm run validate:device-evidence <campaign.json>`.
2. Record actual conferencing compatibility outcomes (Zoom, Teams, Google Meet, Discord, OBS).
3. Record live paid subscription activation once Lemon Squeezy Plus/Pro product and variant IDs are configured in `app/electron/config/billing-products.ts`.
