# Production Release Automation

## Next release target

The published [`v1.0.2`](https://github.com/MokuLakshithReddy/Scandium-Assistant/releases/tag/v1.0.2) release is an **unsigned CI validation prerelease** pointing to an older commit, **not** a signed production release. The next signed production release must be tagged from the exact verified `main` commit (matching `package.json` and `app/package.json`, e.g., bumping to `v1.0.3` once all blockers are cleared).

The release workflow is `.github/workflows/release.yml` (**Signed Production Release**). It runs only when a version tag is pushed and **strictly fails closed** unless:
- the tag version matches both root and app package versions;
- the tag points to the exact current `main` commit;
- `RELEASE_GPG_PUBLIC_KEY` is configured and `git verify-tag` succeeds;
- `docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json` and its detached human sign-off GPG signature `docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json.asc` exist, pass `gpg --verify`, and pass strict 40-case validation via `node scripts/validate-device-evidence.cjs docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json --expected-commit <SHA> --expected-version <semver>` (incomplete campaigns, placeholder SHA-256 digests, missing platforms, or stale commits fail closed);
- readiness issues #19, #47, #48, #49, #50, #51, #52, #60, and #73 are closed with the `completed` reason;
- the production dependency audit (`npm audit --omit=dev --audit-level=high`) passes with 0 critical/high findings (while capturing and uploading both full and production audit reports);
- source verification passes on Node.js 24.22.2 (Python STT protocol tests, lint, Vitest, build, Electron smoke, test report);
- Windows Authenticode secrets and macOS Developer ID / notarization secrets are configured (`forceCodeSigning: true`, `mac.notarize: true` — unsigned production builds are rejected);
- Windows, macOS, and Linux distributables are generated with the bundled standalone Python runtime and pass real RealtimeSTT fixture inference plus packaged renderer/preload/IPC launch smoke;
- Windows Authenticode signature + exact certificate thumbprint and macOS `codesign` + Team ID + stapled notarization checks pass;
- `SHA256SUMS.txt` is generated, checked, GPG-signed (`SHA256SUMS.txt.asc`), and verified with `gpg --verify`.

A CI package artifact is not a release until this workflow completes and attaches all signed platform assets and the GPG-signed checksum manifest.

## Current readiness state

- **Production runtime audit:** `npm audit --omit=dev` reports **0 vulnerabilities** (enforced in both `ci.yml` and `release.yml`). Full workspace audit still reports 18 high-severity `picomatch` dev/build-tooling findings ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)) pending an upstream patch; see [`DEPENDENCY_ADVISORY_REVIEW.md`](../security/DEPENDENCY_ADVISORY_REVIEW.md).
- **Physical-device validation (INCOMPLETE):** `DEVICE_EVIDENCE_RUN.json` is a partial Windows host snapshot, not the required 40-case signed campaign across Windows, macOS, and Linux; all platforms remain `NOT APPROVED` in [`DEVICE_VALIDATION_MATRIX.md`](../testing/DEVICE_VALIDATION_MATRIX.md).
- **Signed release automation (FAIL-CLOSED, SECRETS PENDING):** `.github/workflows/release.yml` strictly rejects unsigned builds and missing GPG/Authenticode/Apple credentials. Signing secrets have not yet been configured for production publication.
- **Paid subscriptions (NOT READY):** `app/electron/config/billing-products.ts` intentionally leaves Plus and Pro product/variant IDs empty and `website/index.html` keeps checkout disabled until real Lemon Squeezy products are created and tested.
- **Latest verified `main` CI:** Commit [`2b8d50a`](https://github.com/MokuLakshithReddy/Scandium-Assistant/commit/2b8d50a7d4424f2a506bc3e72af86982e727bb03) passed [CI Verification Suite run 44170502005](https://github.com/MokuLakshithReddy/Scandium-Assistant/actions/runs/44170502005) (255 automated checks + Windows/macOS/Linux unsigned validation packages and launch smoke tests).

## Required repository Actions secrets

Configure these secrets before creating the v1.0.2 tag:

| Secret | Purpose |
|---|---|
| `WINDOWS_CSC_LINK` | Base64-encoded Windows Authenticode PFX certificate (injected as electron-builder `WIN_CSC_LINK`) |
| `WINDOWS_CSC_KEY_PASSWORD` | Password for the Windows signing certificate (injected as `WIN_CSC_KEY_PASSWORD`) |
| `WINDOWS_EXPECTED_CERT_THUMBPRINT` | Exact 40-character hexadecimal Authenticode certificate thumbprint expected on the Windows executable |
| `MACOS_CSC_LINK` | Base64-encoded Apple Developer ID signing certificate (injected as `CSC_LINK`) |
| `MACOS_CSC_KEY_PASSWORD` | Password for the Apple signing certificate (injected as `CSC_KEY_PASSWORD`) |
| `APPLE_ID` | Apple developer account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `RELEASE_GPG_PUBLIC_KEY` | ASCII-armored public key used to verify the signed Git tag |
| `RELEASE_GPG_PRIVATE_KEY` | ASCII-armored private key used to sign the checksum manifest |
| `RELEASE_GPG_PASSPHRASE` | Passphrase for the release GPG private key |

Keep signing secrets in GitHub Actions secrets; never commit certificates, passwords, private keys, provider keys, or token material. For Windows PFX certificates, ensure the base64 value fits Windows environment-variable limits; electron-builder documents the `WIN_CSC_LINK` path and encoding requirements in its [code-signing guide](https://www.electron.build/docs/features/code-signing/). The release workflow also compares the Windows executable's Authenticode certificate thumbprint with `WINDOWS_EXPECTED_CERT_THUMBPRINT`; obtain that exact thumbprint from the approved publisher certificate and update it when the certificate is renewed. For macOS, the workflow verifies that the app is signed by a `Developer ID Application` certificate whose `TeamIdentifier` exactly matches `APPLE_TEAM_ID`, then validates the stapled notarization ticket.

## Create and push the signed release tag

After all release PRs have merged and current `main` has a successful CI run, use the GPG key whose public key is stored as `RELEASE_GPG_PUBLIC_KEY`:

```bash
git fetch origin main
git checkout main
git pull --ff-only
git tag -s v1.0.2 -m "Scandium Copilot v1.0.2"
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
