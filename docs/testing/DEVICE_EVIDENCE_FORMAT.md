# Device Validation Evidence Format

This document defines the machine-checkable record used with
[\`DEVICE_VALIDATION_MATRIX.md\`](./DEVICE_VALIDATION_MATRIX.md). It makes device evidence
traceable and reviewable; it does **not** run hardware tests or certify that a result is
genuine. The operator must execute the matrix against the packaged application on real
hardware and attach sanitized evidence.

## Required coverage

A completed release campaign must contain at least one run for each release target:

- \`windows\` — the exact Windows release/build and x64 hardware combination tested.
- \`macos\` — the exact macOS release/build and hardware architecture tested.
- \`linux\` — each Linux distribution / desktop-session combination claimed as supported.

Add another run when a separately claimed OS build, architecture, device class, Linux
distribution, or audio/display path needs independent coverage. Each run must include every
test ID below. Use \`NOT_APPLICABLE\` only with a written, technically justified reason.
Do not remove a test to make a campaign pass.

| Area | Test IDs | Coverage |
|---|---|---|
| A — Microphone lifecycle | \`A-01\`–\`A-06\` | Permission grant/denial/revocation, disconnect, reselection, local capture |
| B — System audio | \`B-01\`–\`B-06\` | Real loopback, speaker attribution, overlap, output switching, disconnect, meeting lifecycle |
| C — Display capture | \`C-01\`–\`C-05\` | Capture grant, denial, cancellation, revocation, multi-display/hot-plug/sleep-wake |
| D — Emergency stop and purge | \`D-01\`–\`D-06\` | Live tracks, emergency stop, restart capture, purge, late-callback prevention, persisted-data check |
| E — Live provider/network | \`E-01\`–\`E-05\` | STT, streaming LLM, invalid credentials/models, throttling/network failure, abort/recovery/secret handling |
| F — Display protection | \`F-01\`–\`F-08\` | Zoom, Teams, Meet, Discord, OBS, native capture, app-window capture, documented limitations |
| G — Stability/lifecycle | \`G-01\`–\`G-04\` | 30-minute session, window/device changes, sleep/wake/restart, quit/shutdown |

The validator requires all 40 IDs in every run and coverage of all three release platforms.
The release owner remains responsible for deciding the exact supported OS versions and
additional device configurations to include.

## Campaign JSON structure

Create one JSON file per release candidate. The top-level object has:

- \`schemaVersion\`: integer \`1\`.
- \`candidate\`: \`version\`, 40-character \`commit\`, \`ciRunUrl\`, \`electronVersion\`,
  and \`nodeVersion\`.
- \`runs\`: one object per tested hardware / OS configuration. Each run has a unique \`id\`,
  \`platform\` (\`windows\`, \`macos\`, or \`linux\`), \`osRelease\`, \`osBuild\`,
  \`architecture\`, \`hardware\`, \`microphoneDevice\`, \`audioRoute\`,
  \`displayConfiguration\`, and the exact packaged \`artifactName\`, \`artifactUrl\`,
  and 64-character \`artifactSha256\`.
- \`runs[].records\`: 40 records, one for each test ID. Every executed record includes
  \`operator\`, ISO-8601 \`executedAt\`, and \`actualResult\`. A \`PASS\` also requires at
  least one HTTPS \`evidenceUrls\` link. \`FAIL\`, \`BLOCKED\`, and \`NOT_APPLICABLE\`
  require a useful \`reason\`.
- \`signOff\`: release-owner reviewer, ISO-8601 \`reviewedAt\`, and an HTTPS
  \`evidenceUrl\` linking to the reviewed campaign/sign-off.

Example of one run (the other two platforms and all remaining records must also be present
before final sign-off):

\`\`\`json
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
\`\`\`

The example is intentionally incomplete and will not pass the final validator.

## Validation

The command uses only Node.js built-ins and adds no runtime dependencies:

\`\`\`bash
# While collecting evidence: validate structure but allow NOT_RUN / FAIL / BLOCKED records.
node scripts/validate-device-evidence.cjs path/to/device-validation-campaign.json --allow-incomplete

# Before issue #49 sign-off: require every test to be PASS or justified NOT_APPLICABLE,
# valid evidence links for PASS results, all three platform targets, and owner sign-off.
node scripts/validate-device-evidence.cjs path/to/device-validation-campaign.json
\`\`\`

A successful final validation proves only that the submitted record is structurally complete.
A human reviewer must still open the evidence links, confirm the exact artifact hashes,
review failed/exceptional cases, and verify that the operator actually ran the tests on the
stated physical devices. Synthetic tracks, mocked permissions, CI package smoke tests, or
unsigned CI artifacts cannot be entered as device evidence.

Never place API keys, raw meeting audio, other participants' personal data, or unredacted
private logs in evidence attachments.
