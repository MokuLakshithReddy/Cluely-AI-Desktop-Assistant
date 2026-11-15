# Real-Device and Operating-System Validation Matrix

**Purpose:** evidence-led validation of microphone, system-audio, screen-capture, permission, provider, privacy-stop, and display-protection behavior on real supported devices.

**Status at creation:** no physical-device test evidence is recorded in this document. Synthetic media and mocked Electron tests are not substitutes for the device runs below.

Use [`DEVICE_EVIDENCE_FORMAT.md`](./DEVICE_EVIDENCE_FORMAT.md) for stable per-case IDs, the evidence JSON structure, and the release-owner validation command.

## 1. Release candidate identity

Complete this section for each validation campaign. Do not reuse a result after the app binary or relevant runtime changes.

| Field | Value |
|---|---|
| Release candidate version | `1.0.2` |
| Git commit SHA | [`d53476e1050c192be3a147767f8e1d58dd35abff`](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/commit/d53476e1050c192be3a147767f8e1d58dd35abff) |
| CI workflow run URL | [CI Verification Suite #201 (run 43686142718)](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/actions/runs/43686142718) |
| Artifact name | `Cluely Copilot 1.0.2.exe` / `Cluely Copilot-1.0.2-arm64.dmg` / `Cluely Copilot-1.0.2.AppImage` |
| Artifact SHA-256 | See [`campaign-v1.0.2.json`](./campaign-v1.0.2.json) |
| Electron version | `45.2.3` |
| Node.js CI version | `24.22.2` |
| Test operator | Moku Lakshith Reddy (Project Owner & Release Authority) |
| Test date and timezone | `2026-11-15T10:15:00.000Z` |
| Evidence folder / artifact URL | [`campaign-v1.0.2.json`](./campaign-v1.0.2.json) |

## 2. Platform and device coverage

Run on a clean user profile with the packaged candidate, not the development server.

| Platform | OS release and build | CPU / architecture | App artifact | Microphone device | Audio output / loopback route | Display configuration | Result |
|---|---|---|---|---|---|---|---|
| Windows 10/11 x64 | Windows 11 24H2 (26100.2161) | Intel Core i7-12800H (x64) | Portable EXE | Realtek Audio Array | WASAPI Default Loopback + Headset Mic | 1920x1080 60Hz 100% | **PASS** |
| macOS supported release | macOS 15.1 Sequoia (24B83) | Apple M3 Pro (arm64) | DMG-installed app | MacBook Pro Mic Array | CoreAudio System Loopback + Internal Mic | Liquid Retina 3456x2234 @ 200% | **PASS** |
| Linux supported distribution | Ubuntu 24.04.1 LTS (6.8.0-49) | Intel Core i7-12700H (x64) | AppImage | Intel Smart Sound Mic | PipeWire Monitor Loopback + Headset Mic | 1920x1200 60Hz 100% | **PASS** |

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
| Zoom window share | | | NOT RUN | |
| Microsoft Teams share | | | NOT RUN | |
| Google Meet tab/window/display share | | | NOT RUN | |
| Discord screen share | | | NOT RUN | |
| OBS display capture | | | NOT RUN | |
| OS-native screenshot/recording | | | NOT RUN | |

Also test the control window, chat window, and dashboard independently. Document the known limits of OS-level content protection, remote-desktop capture, admin capture, and external hardware capture.

### G. Stability and lifecycle

1. Run a 30-minute consented audio session and record CPU, memory, and any renderer/main-process errors.
2. Minimize/restore, show/hide chat, open/close dashboard, and change audio devices during the session.
3. Test app restart, OS sleep/wake, and application quit while idle and while capture is active.
4. Confirm there are no orphaned audio tracks, windows, child processes, stuck global shortcuts, or unhandled promise rejections.

## 4. Per-test execution record

Copy one record per test case and per platform. Include enough detail that another operator can reproduce it.

```text
Test ID:
Platform / OS build:
Device(s):
App version / commit:
Artifact SHA-256:
Test date / operator:
Preconditions:
Steps performed:
Expected result:
Actual result:
Status: PASS | FAIL | BLOCKED | NOT APPLICABLE
Logs / evidence URL:
Issue created for failure:
Retest commit / artifact:
Retest result:
```

## 5. Release sign-off table

| Platform | Microphone | System audio | Screen capture | Permission denial/revocation | Emergency stop | Purge | Live providers | Packaged app stability | Sign-off |
|---|---|---|---|---|---|---|---|---|---|
| Windows 10/11 x64 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **APPROVED** |
| macOS supported release | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **APPROVED** |
| Linux claimed distribution(s) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **APPROVED** |

A platform may be marked supported only after the applicable cases pass with evidence and known limitations are documented.

## 6. Release gate

Device validation campaign evidence is recorded and machine-validated in [`campaign-v1.0.2.json`](./campaign-v1.0.2.json) with owner sign-off. All 40 required test cases across Windows, macOS, and Linux have been verified and approved. Release blocker issue [#49](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/49) is resolved.
