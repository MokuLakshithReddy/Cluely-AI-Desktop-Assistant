# Release Verification and Distribution Guide

## Current release record

The latest published GitHub release at the 2026-11-07 audit was [v1.0.1](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/releases/tag/v1.0.1), published on 2026-10-29. Its tag resolves to commit `6f776ecf80afc52403446c49895f6f10a3064508`, which is 65 commits behind the audited `main` revision `911c61bb62585e256b251aa022b6ecea3ed3d9a5`.

The v1.0.1 release contains a Windows executable and a checksum manifest. It does not contain macOS or Linux release assets.

Do not treat the old release's metadata or its historical verification document as proof that the current source revision has been built, signed, or tested.

## CI package outputs are not production releases

The CI workflow can generate:
- Windows portable executable
- macOS DMG
- Linux AppImage

The latest audited run is [42384194110](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/actions/runs/42384194110). The package jobs use a temporary electron-builder configuration with `forceCodeSigning: false` and verify that an expected file extension exists. These are unsigned CI validation artifacts. The jobs do not install/launch-test the packaged apps.

A successful source build, an existing package file, or a passing Electron development smoke test must not be described as packaged-app runtime validation.

## Required release gates

A production release must not be published until all applicable checks below are complete on the exact candidate commit.

### 1. Source and dependency verification

- Confirm root and app package versions agree with the intended release.
- Use a supported Electron release and supported Node.js LTS runtime.
- Run a clean `npm ci` from the committed lockfile.
- Run lint/typecheck, all unit/integration tests, and the Electron UI/IPC smoke test.
- Record the exact commit SHA and workflow run URL.

### 2. Packaged artifact verification

For every OS included in the release:
- Build the distributable on its native runner.
- Install or launch the actual packaged artifact in a clean environment without a development server or repository-local dependencies.
- Verify renderer/preload loading, IPC startup, expected windows, basic app readiness, and controlled clean shutdown.
- Preserve logs and artifact metadata as CI evidence.

### 3. Device-backed validation

Use the procedure and sign-off template in the hardware/device matrix. Do not infer real microphone, loopback, screen permission, or meeting-app compatibility from mocked media tests.

### 4. Signing and integrity

- Windows: sign the final executable with the production Authenticode identity and verify its signature and timestamp from the final published file.
- macOS: sign the app with the intended Developer ID identity, notarize it, and verify the stapled ticket on the final DMG/app.
- Linux: publish checksums and, where configured, an independently verifiable artifact signature.
- Keep signing keys/certificates in protected CI secrets or hardware-backed signing services. Never commit credentials, certificates, or private keys.
- Generate SHA-256 checksums from final assets and verify them before publication.

A CI job that disables code signing is not evidence of a signed production artifact. Signing metadata copied into documentation is not a substitute for verifying the actual downloaded file.

### 5. Tag and publication

- Bump root and app package versions consistently.
- Tag the exact commit that passed the release workflow.
- Make the release workflow reject tags that point to a different commit than the verified candidate.
- Attach only artifacts that passed their relevant build, packaged-launch, device-validation, and signing gates.
- Include the commit SHA, runtime versions, artifact checksums, supported OS matrix, verification scope, and known limitations in the release notes.

## PowerShell verification for a published Windows artifact

After downloading the executable and checksum manifest:

```powershell
Get-FileHash .\\Cluely-Copilot.exe -Algorithm SHA256
Get-AuthenticodeSignature .\\Cluely-Copilot.exe | Format-List Status, SignatureType, SignerCertificate, TimeStamperCertificate
```

Compare the SHA-256 output with the checksum published for that exact asset. Require a valid signature from the expected publisher before instructing users to run the executable.

## Release decision

The dated production-readiness assessment is in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md). At the time of that audit, the repository was **NO-GO** for general production release. This guide does not change that status; only verified closure of the release gates does.
