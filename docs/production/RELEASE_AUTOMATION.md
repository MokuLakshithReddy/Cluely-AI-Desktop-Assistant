# Production Release Automation

## Next release target

The next release candidate is **v1.0.2**. The published v1.0.1 release is historical and must not be reused as evidence for the current source revision.

The release workflow is `.github/workflows/release.yml`. It runs only when a version tag is pushed and refuses publication unless:
- the tag version matches both root and app package versions;
- the tag points to the exact current `main` commit;
- the tag has a valid GPG signature;
- readiness issues #19, #47, #48, #49, #51, #52, and #60 are closed with the completed reason;
- the dependency audit has no critical or high vulnerabilities;
- source verification passes on Node.js 24.22.2;
- Windows, macOS, and Linux distributables are generated;
- Windows Authenticode and macOS code-signing/notarization checks pass;
- each actual packaged app passes the packaged renderer/preload/IPC launch smoke;
- SHA-256 checksums are generated, checked, and GPG-signed.

A CI package artifact is not a release until this workflow completes and attaches all platform assets and the signed checksum manifest.

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

This PR prepares the release automation and bumps the package version to v1.0.2. It cannot create the production certificates, Apple account credentials, or GPG signing key on behalf of the repository owner. The workflow also blocks the release while any required readiness issue remains open, including real-device validation (#49) and dependency security remediation (#60). Until all issues are completed, signing secrets are configured, and the v1.0.2 tag workflow publishes successfully, issue #50 remains open and no new production release should be claimed.
