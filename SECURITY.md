# Security and Disclosure Policy

The Scandium project takes the security of our users, their desktop privacy, and their confidential data with utmost priority. This document outlines our vulnerability disclosure process, supported versions, severity taxonomy, and core architectural security guarantees.

---

## Supported Versions

Only active production release lines receive security updates and patches.

| Version Line | Supported          | Status                                 |
| :----------- | :----------------: | :------------------------------------- |
| `1.0.x`      | :white_check_mark: | Active Security & Maintenance Support  |
| `< 1.0.0`    | :x:                | Deprecated / End of Life               |

---

## Reporting a Security Vulnerability

If you discover a security vulnerability, privilege escalation, credential leakage vector, or data exposure flaw in Scandium Desktop Assistant, **please report it responsibly through private channels**. Do not create public issues, discussions, or pull requests disclosing vulnerabilities before a patch is released.

### Preferred Reporting Channels:
1. **GitHub Private Security Advisory**: Submit an advisory directly via [GitHub Security Advisories](https://github.com/MokuLakshithReddy/Scandium-Assistant/security/advisories/new).
2. **Security Contact**: Contact the maintainer privately via GitHub security reporting.

### Core Security Architecture:
1. **Local-First Processing**: When operating in Local Mode, all AI inference (Ollama) and speech recognition (whisper.cpp) execute on the user's host machine. No audio frames, screenshots, or transcripts leave the local perimeter.
2. **OS-Backed Credential Vault**: BYOK cloud provider keys are encrypted using OS hardware/keychain APIs (DPAPI on Windows, Keychain on macOS, Secret Service on Linux) via AES-256-GCM.
3. **Fail-Closed Persistence**: Session archives and settings are authenticated with AES-256-GCM envelopes. Unauthenticated or corrupted data files trigger fail-closed locks rather than plaintext leaks.
4. **No Owner Gateway**: Cloud AI requests transmit directly from the client application to customer-configured provider endpoints. There is zero owner intermediary or proxy holding keys or traffic.
5. **Asymmetric Licensing Signatures & Replay-Protected Webhooks**: Entitlement licenses are cryptographically signed using Ed25519 (DER PKCS8) by the Scandium Licensing Service and verified on the desktop client using an embedded SPKI public key. Payment webhooks from Paddle enforce constant-time HMAC-SHA256 signature verification (`Paddle-Signature`), 300-second timestamp replay tolerance, and durable event deduplication via Upstash Redis (`SET NX` with 7-day TTL).
