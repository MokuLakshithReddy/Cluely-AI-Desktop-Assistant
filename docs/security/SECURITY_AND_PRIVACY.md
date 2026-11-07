# Security and Privacy Specification

## Scope and security posture

Cluely Copilot is an Electron desktop application that may process microphone audio, system audio, screenshots, documents, chat content, and user-supplied provider credentials. This document describes implemented protections and their limits; it is not a claim of certification or a guarantee against every endpoint, OS, or capture threat.

## Electron renderer boundary

The desktop windows are configured with:
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

The preload exposes a deliberately scoped `desktopBridge` API rather than exposing the Node.js or Electron modules directly. Main-process IPC handlers validate the sender frame URL and validate/sanitize state and request payloads. The windows deny requests to open new windows and guard navigation.

These controls reduce renderer privileges; they do not make unsafe renderer content or a compromised OS harmless. Keep dependencies patched and review every new preload/IPC method as a security boundary change.

## Credentials

- Desktop provider credentials are encrypted using Electron `safeStorage` and stored in the application's local user-data vault.
- Windows uses the OS DPAPI-backed implementation; macOS uses Keychain-backed storage. On Linux, the application accepts only the explicitly allowlisted Secret Service/KWallet backends and rejects `basic_text` and unknown backends.
- Plaintext provider keys are not included in shared renderer state; renderers receive presence flags rather than raw credentials.
- The AES-256-GCM implementation in `CredentialVault` requires an explicit injected test key and exists for headless tests. It is not an automatic production fallback.
- The currently audited implementation uses synchronous `safeStorage` methods. The async migration and compatibility path for existing vault entries are tracked in [#19](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/19). Do not consider the migration complete until that issue and its verification criteria are closed.

OS-backed credential encryption is not a guarantee that secrets are protected from malware or an attacker who already controls the logged-in user account or application process.

## Audio and screen data

- Audio capture is initiated through the application's user-facing controls; users must obtain any required participant consent and comply with workplace and local recording rules.
- Microphone and system-loopback samples are processed in memory through separate VAD pipelines. The pipelines preserve overlapping speech rather than muting one source when the other is active.
- Speech segments are sent to the configured speech-to-text provider. This is external processing when a cloud provider is configured; provider retention and processing terms apply.
- Screenshots are captured when the relevant user action requests visual context and may be sent to the selected AI provider as part of that request.
- The application does not promise that third-party provider services retain no submitted data. Users must review their provider agreements and settings.

Do not describe fake-media tests as physical microphone or system-loopback validation. The automated capture/purge E2E test injects fake media devices, tracks, and audio contexts.

## Local persistence and purge

- Session records and local knowledge data are persisted in the application's user-data area.
- Screenshot payloads are stripped from saved session messages to reduce local retention and storage growth.
- Data purge removes application-managed session archives, the credential vault, and associated active state, and requests teardown of active capture/transcription work.
- Purge is application-level logical deletion. It is not forensic or physical secure erasure; filesystem snapshots, backups, SSD wear-leveling, OS caches, crash dumps, or external provider copies may remain.

## Display capture protection

The application can call Electron's `setContentProtection` when the user enables stealth mode. The OS and capture stack determine how that protection behaves. It is a best-effort mitigation, not a universal promise that the app is invisible to every meeting product, recording tool, remote desktop solution, administrator-level capture method, or external camera/capture card.

## Verification boundaries

Current automated evidence covers static checks, unit/integration tests, the Electron Dashboard/preload/IPC smoke path, and CI package generation. It does not by itself verify:
- physical microphone or system-loopback hardware on all supported OS releases;
- real display permission grant/denial/revocation and multi-monitor behavior;
- compatibility with every meeting or screen-recording application;
- live provider account/model availability or provider-side retention practices;
- launch and operation of every packaged artifact on clean devices.

Track device-backed release testing in [issue #49](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/49) and packaged-app launch validation in [issue #48](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/48).
