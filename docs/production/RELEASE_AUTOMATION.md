# Production Release Automation

## Next release target

The published [`v1.0.2`](https://github.com/MokuLakshithReddy/Scandium-Assistant/releases/tag/v1.0.2) release is an **unsigned CI validation prerelease** pointing to an older commit, **not** a signed production release. Because `v1.0.2` already exists as an unsigned prerelease tag, the next signed production release target is **`v1.0.3`** (root `package.json`, `app/package.json`, and `package-lock.json` remain at `1.0.2` during development and must be bumped together to `1.0.3` when cutting the `v1.0.3` release candidate).

The release workflow is `.github/workflows/release.yml` (**Signed Production Release**). It runs only when a version tag is pushed and **strictly fails closed** unless:
- the tag version matches both root and app package versions;
- the tag points to the exact current `main` commit;
- `RELEASE_GPG_PUBLIC_KEY` is configured and `git verify-tag` succeeds;
- `docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json` and its detached human sign-off GPG signature `docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json.asc` exist, pass `gpg --verify`, and pass strict 40-case validation via `node scripts/validate-device-evidence.cjs docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json --release-commit "$GITHUB_SHA" --expected-version "$tag_version"` (which verifies `candidate.commit` is an ancestor of `$GITHUB_SHA` with **zero non-evidence code, dependency, packaging, or workflow changes** between the tested commit and the tagged sign-off commit);
- readiness issues #19, #47, #48, #49, #51, #52, #60, and #73 are closed with the `completed` reason;
- issue #50 is intentionally excluded from the pre-publication gate because it tracks publication of this release; keep it open until the signed release is published and independently verified, then close it with the `completed` reason;
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
- **Latest verified `main` CI:** Commit [`333d3de`](https://github.com/MokuLakshithReddy/Scandium-Assistant/commit/333d3de668b024cd407e2cb63aae2bead24103fa) passed [CI Verification Suite run #273](https://github.com/MokuLakshithReddy/Scandium-Assistant/actions/runs/44592286282) across `Build & Verify (Windows)` and all three native packaging + packaged launch smoke jobs (`windows-portable`, `macos-dmg`, `linux-appimage`).

## Required repository Actions secrets

Configure these secrets before creating the `v1.0.3` tag:

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
| `RELEASE_GPG_PUBLIC_KEY` | ASCII-armored public key used to verify the signed Git tag and `DEVICE_EVIDENCE_CAMPAIGN.json.asc` |
| `RELEASE_GPG_PRIVATE_KEY` | ASCII-armored private key used to sign the checksum manifest |
| `RELEASE_GPG_PASSPHRASE` | Passphrase for the release GPG private key |

Keep signing secrets in GitHub Actions secrets; never commit certificates, passwords, private keys, provider keys, or token material. For Windows PFX certificates, ensure the base64 value fits Windows environment-variable limits; electron-builder documents the `WIN_CSC_LINK` path and encoding requirements in its [code-signing guide](https://www.electron.build/docs/features/code-signing/). The release workflow also compares the Windows executable's Authenticode certificate thumbprint with `WINDOWS_EXPECTED_CERT_THUMBPRINT`; obtain that exact thumbprint from the approved publisher certificate and update it when the certificate is renewed. For macOS, the workflow verifies that the app is signed by a `Developer ID Application` certificate whose `TeamIdentifier` exactly matches `APPLE_TEAM_ID`, then validates the stapled notarization ticket.

## Create and push the signed release tag (`v1.0.3`)

1. Bump `package.json`, `app/package.json`, and `package-lock.json` to `1.0.3` via PR and merge into `main`. Let that tested candidate commit be `C` (and confirm its CI run passes).
2. Execute the 40-case physical-device campaign on the installers built from commit `C`, recording `candidate.commit = C`, `candidate.version = "1.0.3"`, real artifact SHA-256 digests, and evidence URLs in `docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json`.
3. Cryptographically sign the finalized campaign JSON with the release GPG key:
   ```bash
   gpg --armor --detach-sign --output docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json.asc docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json
   ```
4. Commit **only** the allowlisted evidence and readiness files (`docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json`, `docs/testing/DEVICE_EVIDENCE_CAMPAIGN.json.asc`, `docs/testing/DEVICE_VALIDATION_MATRIX.md`, `docs/production/PRODUCTION_READINESS.md`, `docs/production/RELEASE_AUTOMATION.md`, `docs/production/RELEASE_VERIFICATION.md`) via PR into `main` (let this sign-off commit be `S`). No code, dependency, packaging, or workflow file may change between `C` and `S`.
5. Tag sign-off commit `S` on `main` using the GPG key whose public key is stored as `RELEASE_GPG_PUBLIC_KEY`:

```bash
git fetch origin main
git checkout main
git pull --ff-only
git tag -s v1.0.3 -m "Scandium v1.0.3"
git verify-tag v1.0.3
git push origin v1.0.3
```

The workflow verifies that `v1.0.3` matches `package.json`/`app/package.json`, points to `origin/main`, passes `git verify-tag` and `gpg --verify` on `DEVICE_EVIDENCE_CAMPAIGN.json.asc`, and confirms `candidate.commit` (`C`) is an ancestor of `S` with zero non-evidence code changes in `C..S`.

## Release verification after publication

Download all platform artifacts and `SHA256SUMS.txt` plus `SHA256SUMS.txt.asc`. Import the public GPG key and verify the checksum-manifest signature before running:

```bash
gpg --import release-public-key.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

For Windows, confirm the executable's Authenticode signature is valid and the publisher is the expected identity. For macOS, confirm code signing and the stapled notarization ticket. Linux releases have the GPG-signed checksum manifest.

## Current limitation

No signed production release is claimed yet. Root and app `package.json` currently declare `1.0.2` (matching the existing unsigned `v1.0.2` prerelease) and must be bumped to `1.0.3` when cutting the signed release candidate. The workflow cannot create production certificates, Apple account credentials, or GPG signing keys for the repository owner. Keep issue #49 open until the 40-case device evidence campaign is completed and GPG-signed. Keep issue #50 open as the publication tracker until signing secrets are configured and the signed `v1.0.3` workflow has published all verified assets and the GPG-signed manifest; close #50 only after independently verifying that release.
