# Device Validation Evidence Format

This document defines the machine-checkable record used with
[`DEVICE_VALIDATION_MATRIX.md`](./DEVICE_VALIDATION_MATRIX.md). It makes device evidence
traceable and reviewable; it does **not** run hardware tests or certify that a result is
genuine. The operator must execute the matrix against the packaged application on real
hardware and attach sanitized evidence.

## Required coverage

A completed release campaign must contain at least one run for each release target:

- `windows` — the exact Windows release/build and x64 hardware combination tested.
- `macos` — the exact macOS release/build and hardware architecture tested.
- `linux` — each Linux distribution / desktop-session combination claimed as supported.

Add another run when a separately claimed OS build, architecture, device class, Linux
distribution, or audio/display path needs independent coverage. Each run must include every
test ID below. Use `NOT_APPLICABLE` only with a written, technically justified reason.
Do not remove a test to make a campaign pass.

| Test ID | Required observation |
|---|---|
| `A-01` | Grant microphone permission and start capture from the explicit UI action. |
| `A-02` | Confirm the capture indicator and local-speaker attribution. |
| `A-03` | Deny first-request permission; confirm capture stays stopped and an actionable error appears. |
| `A-04` | Revoke permission during capture; confirm safe stop and recovery after permission is restored. |
| `A-05` | Disconnect/disable the active microphone; confirm tracks and VAD stop without recreating a session. |
| `A-06` | Change the default input device and repeat the capture test. |
| `B-01` | Capture real system/meeting audio from the OS audio path being claimed. |
| `B-02` | Grant required OS permissions and confirm capture starts only after consent. |
| `B-03` | Attribute remote/system speech to the remote speaker. |
| `B-04` | Speak over remote audio; verify both independent sources preserve overlapping speech. |
| `B-05` | Switch output devices and disconnect the active headset; verify recovery/teardown. |
| `B-06` | Pause, resume, and end the meeting; verify stream lifecycle and cleanup. |
| `C-01` | Grant display permission and capture the display explicitly selected by the user. |
| `C-02` | Deny display permission; confirm no fabricated or stale screenshot is shown. |
| `C-03` | Cancel the display picker; confirm capture remains stopped. |
| `C-04` | Revoke screen-recording/display permission after a successful capture; confirm safe failure. |
| `C-05` | Test multiple/mixed-resolution/portrait displays, hot-plug, lock/unlock, sleep/wake, and scaling. |
| `D-01` | Start real microphone and system-audio capture with overlapping speech. |
| `D-02` | Trigger Emergency Stop; observe real track end state, AudioContext closure, and operation abort. |
| `D-03` | Restart capture and verify a clean lifecycle after Emergency Stop. |
| `D-04` | Invoke Purge while real capture and transcription are active. |
| `D-05` | Verify late callbacks cannot recreate transcript/session data after purge. |
| `D-06` | Restart the application and verify purged sessions, knowledge data, and credentials are absent. |
| `E-01` | Complete a successful live STT request for every configured STT provider. |
| `E-02` | Complete a streaming LLM request for every provider/model combination advertised. |
| `E-03` | Test invalid/revoked credentials and an unavailable model. |
| `E-04` | Test HTTP 429, server error, DNS/network loss, and recovery. |
| `E-05` | Abort active transcription/token streams; verify recovery and absence of credentials in logs/state. |
| `F-01` | Verify protected-window behavior during Zoom window sharing. |
| `F-02` | Verify protected-window behavior during Microsoft Teams sharing. |
| `F-03` | Verify protected-window behavior during Google Meet tab/window/display sharing. |
| `F-04` | Verify protected-window behavior during Discord screen sharing. |
| `F-05` | Verify protected-window behavior during OBS display capture. |
| `F-06` | Verify behavior with OS-native screenshot and recording tools. |
| `F-07` | Test control, chat, and dashboard windows independently. |
| `F-08` | Record actual limitations for OS-level protection, remote desktop, admin capture, and external capture. |
| `G-01` | Run a consented 30-minute session; record CPU, memory, and process/renderer errors. |
| `G-02` | Minimize/restore windows, show/hide chat, open/close dashboard, and change devices during capture. |
| `G-03` | Test restart and OS sleep/wake while idle and while capture is active. |
| `G-04` | Quit while idle and while capture is active; verify no orphan tracks, windows, processes, or shortcuts. |

The validator requires all 40 IDs in every run and coverage of all three release platforms.
The release owner remains responsible for deciding the exact supported OS versions and
additional device configurations to include.

## Campaign JSON structure

Create one JSON file per release candidate. The top-level object has:

- `schemaVersion`: integer `1`.
- `candidate`: `version`, 40-character `commit`, `ciRunUrl`, `electronVersion`,
  and `nodeVersion`.
- `runs`: one object per tested hardware / OS configuration. Each run has a unique `id`,
  `platform` (`windows`, `macos`, or `linux`), `osRelease`, `osBuild`,
  `architecture`, `hardware`, `microphoneDevice`, `audioRoute`,
  `displayConfiguration`, and the exact packaged `artifactName`, `artifactUrl`,
  and 64-character `artifactSha256`.
- `runs[].records`: 40 records, one for each test ID. Every executed record includes
  `operator`, ISO-8601 `executedAt`, and `actualResult`. A `PASS` also requires at
  least one HTTPS `evidenceUrls` link. `FAIL`, `BLOCKED`, and `NOT_APPLICABLE`
  require a useful `reason`.
- `signOff`: release-owner reviewer, ISO-8601 `reviewedAt`, and an HTTPS
  `evidenceUrl` linking to the reviewed campaign/sign-off.

Example of one run (the other two platforms and all remaining records must also be present
before final sign-off):

```json
{
  "schemaVersion": 1,
  "candidate": {
    "version": "1.0.2",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "ciRunUrl": "https://github.com/OWNER/REPO/actions/runs/123456",
    "electronVersion": "45.2.3",
    "nodeVersion": "24.22.2"
  },
  "runs": [
    {
      "id": "windows-11-24h2-x64-device-01",
      "platform": "windows",
      "osRelease": "Windows 11 24H2",
      "osBuild": "record-the-exact-build",
      "architecture": "x64",
      "hardware": "manufacturer and model",
      "microphoneDevice": "manufacturer and model",
      "audioRoute": "input/output/loopback route",
      "displayConfiguration": "monitor count, resolution, scaling",
      "artifactName": "Cluely-Copilot-1.0.2-windows.exe",
      "artifactUrl": "https://example.invalid/evidence/windows.exe",
      "artifactSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "records": [
        {
          "testId": "A-01",
          "status": "PASS",
          "operator": "operator identifier",
          "executedAt": "2026-11-09T09:00:00.000Z",
          "actualResult": "Describe the observed result, not only the expected result.",
          "evidenceUrls": ["https://example.invalid/evidence/A-01-redacted-log.txt"]
        }
      ]
    }
  ],
  "signOff": {
    "reviewer": "release owner",
    "reviewedAt": "2026-11-09T10:00:00.000Z",
    "evidenceUrl": "https://example.invalid/evidence/release-owner-signoff"
  }
}
```

The example is intentionally incomplete and will not pass the final validator.

## Validation

The command uses only Node.js built-ins and adds no runtime dependencies:

```bash
# While collecting evidence: validate structure but allow NOT_RUN / FAIL / BLOCKED records.
node scripts/validate-device-evidence.cjs path/to/device-validation-campaign.json --allow-incomplete

# Before issue #49 sign-off: require every test to be PASS or justified NOT_APPLICABLE,
# valid evidence links for PASS results, all three platform targets, and owner sign-off.
node scripts/validate-device-evidence.cjs path/to/device-validation-campaign.json
```

A successful final validation proves only that the submitted record is structurally complete.
A human reviewer must still open the evidence links, confirm the exact artifact hashes,
review failed/exceptional cases, and verify that the operator actually ran the tests on the
stated physical devices. Synthetic tracks, mocked permissions, CI package smoke tests, or
unsigned CI artifacts cannot be entered as device evidence.

Never place API keys, raw meeting audio, other participants' personal data, or unredacted
private logs in evidence attachments.
