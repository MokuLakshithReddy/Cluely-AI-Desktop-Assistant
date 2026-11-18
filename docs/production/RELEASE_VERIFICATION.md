# Release Verification and Distribution Guide

## Current release record

The published [`v1.0.2`](https://github.com/MokuLakshithReddy/Scandium-Assistant/releases/tag/v1.0.2) GitHub release is an **unsigned CI validation prerelease** pointing to an older commit (not current `main`), with a SHA-256 file but **no GPG-signed checksum manifest** (`SHA256SUMS.txt.asc`). No signed production release has been published for the current `main` codebase yet.

The latest verified `main` revision is [`2b8d50a`](https://github.com/MokuLakshithReddy/Scandium-Assistant/commit/2b8d50a7d4424f2a506bc3e72af86982e727bb03). Its [CI Verification Suite run 44170502005](https://github.com/MokuLakshithReddy/Scandium-Assistant/actions/runs/44170502005) completed successfully: source verification passed, 255 automated checks passed (254 Vitest tests plus one Electron UI/IPC smoke check), bundled RealtimeSTT real-audio transcription passed, and Windows, macOS, and Linux unsigned packaged-app launch jobs all passed.

Do not use the `v1.0.2` prerelease or CI validation assets as evidence that production code-signing, Apple notarization, GPG manifest signing, physical-device sign-off, or live paid subscription checkout have completed.

## CI validation artifacts are not production releases

The CI workflow generates:
- Windows portable executable
- macOS DMG
- Linux AppImage

The merged-main CI run builds and launch-tests the actual packaged applications on native Windows, macOS, and Linux runners. It checks packaged renderer/preload/IPC readiness and controlled shutdown. These are useful packaged-launch checks, but the CI packaging configuration explicitly disables code signing for pull-request/main validation.

Therefore:
- CI package artifacts are **unsigned validation artifacts**, not production distributables.
- A packaged-launch smoke pass does not prove physical microphone, system-loopback, display-permission, or live-provider behavior.
- A successful CI run does not create a GitHub production release.
- Do not distribute CI artifacts as signed production installers.

## Required release gates

A production release must not be published until all applicable checks below are complete on the exact candidate commit.

### 1. Source and dependency verification

- Confirm root and app package versions agree with the intended release version.
- Use the committed lockfile and a clean `npm ci`.
- Run lint/typecheck, all unit/integration tests, and the Electron UI/IPC smoke test.
- Retain the machine-readable dependency audit reports (`npm-audit-production.json` and `npm-audit-full.json`). Both `ci.yml` and `release.yml` enforce `npm audit --omit=dev` (0 production runtime vulnerabilities) while transparently disclosing the 18 upstream `picomatch` dev/build-tooling findings (`GHSA-fc5q-39xc-vjpf`) tracked in [`DEPENDENCY_ADVISORY_REVIEW.md`](../security/DEPENDENCY_ADVISORY_REVIEW.md).
- Record the exact commit SHA and workflow run URL.

### 2. Packaged artifact verification

For every OS included in the release:
- Build the distributable on its native runner.
- Launch the actual packaged artifact in a clean environment without a development server or repository-local dependencies.
- Verify renderer/preload loading, IPC startup, expected windows, basic app readiness, and controlled clean shutdown.
- Preserve logs and artifact metadata as CI evidence.

The merged-main CI run above passed the packaged launch jobs on Windows, macOS, and Linux. Those packages are **unsigned CI validation artifacts**. Repeat the source, package, device, and signing checks for the exact signed release candidate.

### 3. Device-backed validation

Complete and sign off [DEVICE_VALIDATION_MATRIX.md](../testing/DEVICE_VALIDATION_MATRIX.md) on physical devices. Do not infer real microphone, loopback, screen permission, live provider, emergency-stop, or purge compatibility from mocked media tests or packaged launch checks.

Issue [#49](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/49) remains open until the actual device runs and evidence are attached and reviewed.

### 4. Signing and integrity

- Windows: sign the final executable with the production Authenticode identity and verify its signature and timestamp from the final published file.
- macOS: sign the app with the intended Developer ID identity, notarize it, and verify the stapled ticket on the final DMG/app.
- Linux: publish checksums and the GPG-signed checksum manifest.
- Keep signing keys/certificates in protected CI secrets or hardware-backed signing services. Never commit credentials, certificates, or private keys.
- Generate SHA-256 checksums from final assets and verify them before publication.

A CI job that disables code signing is not evidence of a signed production artifact. Signing metadata copied into documentation is not a substitute for verifying the actual downloaded file.

### 5. Tag and publication

- Confirm root and app package versions are both `1.0.2`.
- Create a signed `v1.0.2` tag on the exact main commit that passes the release workflow.
- Make the release workflow reject tags that point to a different commit than the verified candidate.
- Attach only artifacts that passed their relevant build, packaged-launch, device-validation, and signing gates.
- Include the commit SHA, runtime versions, artifact checksums, supported OS matrix, verification scope, and known limitations in the release notes.

See [RELEASE_AUTOMATION.md](RELEASE_AUTOMATION.md) for the required repository secrets and tag procedure.

## PowerShell verification for a published Windows artifact

After downloading the executable and checksum manifest:

```powershell
Get-FileHash .\Scandium-Setup-1.0.2.exe -Algorithm SHA256
Get-AuthenticodeSignature .\Scandium-Setup-1.0.2.exe | Format-List Status, SignatureType, SignerCertificate, TimeStamperCertificate
```

Compare the SHA-256 output with the checksum published for that exact asset. Require a valid signature from the expected publisher before instructing users to run the executable.

## Release decision

The current production-readiness assessment is in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md). The project remains **NO-GO** for general production distribution until physical-device validation, production signing/notarization, and the signed v1.0.2 publication gates are complete.
