# Security and Disclosure Policy

The Cluely project takes the security of our users, their desktop privacy, and their confidential data with utmost priority. This document outlines our vulnerability disclosure process, supported versions, severity taxonomy, and core architectural security guarantees.

---

## Supported Versions

Only active production release lines receive security updates and patches.

| Version Line | Supported          | Status                                 |
| :----------- | :----------------: | :------------------------------------- |
| `1.0.x`      | :white_check_mark: | Active Security & Maintenance Support  |
| `< 1.0.0`    | :x:                | Deprecated / End of Life               |

---

## Reporting a Security Vulnerability

If you discover a security vulnerability, privilege escalation, credential leakage vector, or data exposure flaw in Cluely Desktop Assistant, **please report it responsibly through private channels**. Do not create public issues, discussions, or pull requests disclosing vulnerabilities before a patch is released.

### Preferred Reporting Channels:
1. **GitHub Private Security Advisory**: Submit an advisory directly via [GitHub Security Advisories](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/security/advisories/new).
2. **Security Email**: Contact the security team directly at [`security@cluely.ai`](mailto:security@cluely.ai).

### Information to Include in Your Report:
- Detailed description of the vulnerability and its potential security impact.
- Step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
- Affected platform (Windows, macOS, or Linux) and Cluely app version.
- Any proposed mitigations or remediation steps.

---

## Response & Disclosure Timeline

We adhere to responsible disclosure principles and commit to the following response timeline:

- **Initial Acknowledgment**: Within **48 hours** of report receipt.
- **Triage & Reproduction**: Within **7 to 14 calendar days**, confirming severity and scope.
- **Fix & Patch Deployment**: Within **30 calendar days** for Critical or High severity vulnerabilities.
- **Public Disclosure**: Coordinated disclosure after the patch has been published and users have had reasonable opportunity to update (typically 90 days after initial report or sooner by mutual agreement).

---

## Vulnerability Severity Classification

Vulnerabilities are evaluated using the Common Vulnerability Scoring System (CVSS v3.1):

| Severity | CVSS Score | Description & Examples | Target Resolution |
| :--- | :--- | :--- | :--- |
| **Critical** | 9.0 – 10.0 | Remote Code Execution (RCE), Electron sandbox escapes, arbitrary memory execution, unauthenticated credential exfiltration from OS vault. | Within 7 days |
| **High** | 7.0 – 8.9 | Outbound credential leak / redaction bypass, unauthorized loopback audio capture without consent, TLS certificate validation bypass, persistent screen capture bypass. | Within 14 days |
| **Medium** | 4.0 – 6.9 | Local denial of service, improper input validation in non-privileged IPC routes, session file integrity flaws. | Within 30 days |
| **Low** | 0.1 – 3.9 | Minor information leakage in debug console, non-sensitive telemetry leaks, harmless UI rendering quirks. | Next release cycle |

---

## 12 Pillars of Security & Privacy in Cluely

Cluely Desktop Assistant is built from the ground up on zero-trust and local-first security principles:

1. **Sensitive-Content Redaction**: Pre-flight regex and token scanners scrub passwords, API keys (`sk-...`, `AKIA...`, `AIzaSy...`, GitHub PATs, Slack tokens), private keys, JWTs, credit card numbers, and MFA codes before any text or OCR payload is processed.
2. **Strict Local-Only Processing Mode (`PRIVACY_MODE=LOCAL`)**: Complete offline isolation routing all inference directly to local Ollama (`http://localhost:11434`). Zero cloud network calls are permitted.
3. **Ephemeral Volatile-Only Screen Context**: Desktop screenshots are kept strictly in volatile memory. Persistent screenshot saving to disk is permanently disabled. Buffers are overwritten with zeros (`buf.fill(0)`) immediately after inference.
4. **OS Hardware-Bound Credential Storage**: API credentials and secrets are encrypted via OS native keychains (Windows DPAPI, macOS Keychain, Linux Secret Service). Insecure plaintext fallbacks are rejected.
5. **AES-256-GCM Local Database Encryption**: Stored meeting archives, transcripts, and session documents are encrypted at rest with authenticated AES-256-GCM.
6. **Hardened Electron Runtime Architecture**:
   - `nodeIntegration: false`
   - `contextIsolation: true`
   - `sandbox: true`
   - `webSecurity: true`
   - Strict IPC channel whitelist validation without dynamic code evaluation (`eval`).
7. **Permission Transparency**: Visible, real-time indicators in the UI display active capture states (`🎙 Audio Recording Active`, `🖥 Screen Monitoring Active`). No hidden capture modes.
8. **Meeting Privacy Guard**: Explicit multi-option user consent (`Prompt Every Time`, `Allow Once`, `Always Allow`, `Deny Loopback`) is enforced before system loopback audio is captured.
9. **Outbound Data Inspection**: Egress gatekeeper inspects all outgoing requests to third-party providers. If `blockOutboundSecrets` is enabled, any packet containing detected secrets is immediately aborted.
10. **Strict Network & TLS Security**: Mandatory HTTPS for all external endpoints, strict TLS 1.3 certificate validation, and rejection of invalid or self-signed certificates.
11. **Privacy-First Telemetry Opt-In**: Telemetry is disabled by default (`telemetryEnabled: false`). No personal identifiers, audio, transcripts, images, or prompts are ever collected.
12. **Enterprise Compliance Mode (`ENTERPRISE_MODE=true`)**: Forces strict local-only execution, suppresses transcript and session disk persistence, blocks telemetry, and requires consent for all audio operations.

