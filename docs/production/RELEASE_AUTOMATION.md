# Production Release Automation

## Next release target

The next release candidate is **v1.0.2**. The previous published v1.0.1 release is historical and must not be reused as evidence for the current source revision.

The release workflow is `.github/workflows/release.yml`. It runs only when a version tag is pushed and refuses publication unless:
- the tag version matches both root and app package versions;
- the tag points to the exact current `main` commit;
- the tag has a valid GPG signature;
- readiness issues #19, #47, #48, #49, #51, #52, #60, and #73 are closed with the completed reason;
- the dependency audit has no critical or high vulnerabilities;
- source verification passes on Node.js 24.22.2;
- Windows, macOS, and Linux distributables are generated;
- Windows Authenticode and macOS code-signing/notarization checks pass;
- each actual packaged app passes the packaged renderer/preload/IPC launch smoke;
- SHA-256 checksums are generated, checked, and GPG-signed.

A CI package artifact is not a release until this workflow completes and attaches all platform assets and the signed checksum manifest.

## Current readiness state

- Issue [#60](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/60) is closed as completed after merged PR #62 added the committed-lockfile audit artifact and blocking high/critical gate. The audit still reports six moderate paths for one `minimatch` build-tooling advisory; the repository owner accepted the documented mitigation and expiry/re-review date of **2026-12-07**. This is a time-limited exception, not a clean audit result.
- Issue [#49](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/49) remains open until the Windows, macOS, and supported Linux physical-device validation matrix is executed and signed off.
- Issue [#73](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/73) is a production blocker: session archives and shared conversation/knowledge state are currently readable JSON, and must be encrypted with an OS-backed mechanism with a tested legacy migration.
- Issue [#50](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/50) remains open until the signed v1.0.2 workflow publishes the verified release and manifest.
- The latest recorded main revision is [`a9e2ceced6783ebb083bb003a565881c9a38e417`](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/commit/a9e2ceced6783ebb083bb003a565881c9a38e417). CI run [42402797459](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/actions/runs/42402797459) passed source verification and Windows/macOS/Linux package and launch checks. Its outputs are unsigned CI validation artifacts, not a public production release.

## Required repository Actions secrets

Configure these secrets before creating the v1.0.2 tag:

| Secret | Purpose |
|---|---|
| `WINDOWS_CSC_LINK` | Base64-encoded Windows Authenticode PFX certificate (injected as electron-builder `WIN_CSC_LINK`) |
| `WINDOWS_CSC_KEY_PASSWORD` | Password for the Windows signing certificate (injected as `WIN_CSC_KEY_PASSWORD`) |
| `MACOS_CSC_LINK` | Base64-encoded Apple Developer ID signing certificate (injected as `CSC_LINK`) |
| `MACOS_CSC_KEY_PASSWORD` | Password for the Apple signing certificate (injected as `CSC_KEY_PASSWORD`) |
| `APPLE_ID` | Apple developer account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `RELEASE_GPG_PUBLIC_KEY` | ASCII-armored public key used to verify the signed Git tag |
| `RELEASE_GPG_PRIVATE_KEY` | ASCII-armored private key used to sign the checksum manifest |
| `RELEASE_GPG_PASSPHRASE` | Passphrase for the release GPG private key |

Keep signing secrets in GitHub Actions secrets; never commit certificates, passwords, private keys, provider keys, or token material. For Windows PFX certificates, ensure the base64 value fits Windows environment-variable limits; electron-builder documents the `WIN_CSC_LINK` path and encoding requirements in its [code-signing guide](https://www.electron.build/docs/features/code-signing/). macOS notarization is explicitly required by the release packaging config and verified with `xcrun stapler validate`.

## Create and push the signed release tag

After all release PRs have merged and current `main` has a successful CI run, use the GPG key whose public key is stored as `RELEASE_GPG_PUBLIC_KEY`:

```bash
git fetch origin main
git checkout main
git pull --ff-only
git tag -s v1.0.2 -m "Cluely Copilot v1.0.2"
git verify-tag v1.0.2
git push origin v1.0.2
```

The workflow re-checks the tag against `main`; do not move `main` after tagging. If the workflow fails, correct the failure and create a new tag only after the candidate commit is again the verified main head.

## Release verification after publication

Download all platform artifacts and `SHA256SUMS.txt` plus `SHA256SUMS.txt.asc`. Import the public GPG key and verify the checksum-manifest signature before running:

```bash
gpg --import release-public-key.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

For Windows, confirm the executable's Authenticode signature is valid and the publisher is the expected identity. For macOS, confirm code signing and the stapled notarization ticket. Linux releases have the GPG-signed checksum manifest.

## Current limitation

The release automation and the matching root/app v1.0.2 package versions are already merged, but no v1.0.2 production release is claimed here. The workflow cannot create production certificates, Apple account credentials, or GPG signing keys for the repository owner. It also blocks publication while issue #49 remains open. Keep issue #50 open until the required device evidence is accepted, signing secrets are configured, and the v1.0.2 tag workflow publishes all verified signed assets and the manifest.
