# Release Verification and Distribution Guide

## Current release record

The repository is preparing **v1.0.2**. The previous published release is **v1.0.1**; the v1.0.2 release workflow has been added, but this assessment does not claim that v1.0.2 has been published.

The latest recorded main revision is [`a9e2ceced6783ebb083bb003a565881c9a38e417`](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/commit/a9e2ceced6783ebb083bb003a565881c9a38e417). Its [CI Verification Suite run 42402797459](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/actions/runs/42402797459) completed successfully: source verification passed, and Windows, macOS, and Linux packaged-app launch jobs all passed. The run's uploaded test-results artifact records 125/125 automated checks (124 Vitest tests plus one Electron UI/IPC smoke check).

Do not use the v1.0.1 release or its historical assets as evidence that v1.0.2 has been built, signed, tested, or published.

## Current-head recheck — November 11, 2026

Current `main` is `f5cc75be07fff683fec1f776b55c046de77fd9bc`. The latest CI run [42594735278](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/actions/runs/42594735278) failed before the Windows job executed any steps: GitHub reported runner ID 0, no runner name, and zero steps. This is not evidence of a failed application test, but it is also not a successful current-head verification. The 125-check/package-smoke baseline described above belongs to an earlier source revision.

The same pre-runner failure occurred for the new capture-readiness, documentation, and local-file-permission PR checks. Re-run the source verification and platform packaging matrix after GitHub Actions runner allocation is restored. Do not merge or publish based on the historical baseline alone.

## Additional release blocker: local data encryption

Session archives and shared-state conversation/knowledge data are currently persisted as ordinary JSON. API credential encryption with Electron `safeStorage` does not encrypt these separate files. Issue [#73](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/73) tracks OS-backed encryption, plaintext migration, fail-closed behavior, and purge/race tests. The signed-release workflow now includes #73 as a required completed issue.

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
- Retain the machine-readable dependency audit report. The current gate fails on high and critical findings; the six moderate `minimatch` build-tooling paths are covered by the owner-accepted, time-limited exception documented in [DEPENDENCY_ADVISORY_REVIEW.md](../security/DEPENDENCY_ADVISORY_REVIEW.md), expiring for review on 2026-12-07.
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
Get-FileHash .\\Cluely-Copilot.exe -Algorithm SHA256
Get-AuthenticodeSignature .\\Cluely-Copilot.exe | Format-List Status, SignatureType, SignerCertificate, TimeStamperCertificate
```

Compare the SHA-256 output with the checksum published for that exact asset. Require a valid signature from the expected publisher before instructing users to run the executable.

## Release decision

The current production-readiness assessment is in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md). The project remains **NO-GO** for general production distribution until a successful CI run verifies the exact release candidate, physical-device validation is signed off, sensitive local session/conversation/knowledge data is encrypted and migrated, and production signing/notarization and the signed v1.0.2 publication gates are complete.
