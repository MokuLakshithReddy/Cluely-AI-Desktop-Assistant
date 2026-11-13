# Security and Privacy Specification

## Scope and Security Posture

Cluely Copilot is an evidence-driven, privacy-first desktop AI assistant that operates directly alongside user applications. It processes audio streams, screen context, documents, chat messages, and user-supplied AI credentials. This document describes the implemented cryptographic safeguards, data handling boundaries, local-first architectures, and governance controls.

---

## 12 Pillars of Security and Privacy

Cluely implements a defense-in-depth security model across 12 core architectural pillars:

### 1. Sensitive-Content Redaction
Before any screen text, conversation transcript, or document context is passed to AI reasoning models, it passes through an automated redaction engine (`app/src/lib/redaction.ts`):
- **API Keys & Tokens**: Scans and masks OpenAI (`sk-...`), AWS (`AKIA...`), Google Gemini (`AIza...`), GitHub PAT (`ghp_...`), Slack (`xoxb-...`), and generic API tokens.
- **Cryptographic Private Keys**: Detects and redacts RSA, EC, OpenSSH, and PGP private key blocks (`[REDACTED_PRIVATE_KEY]`).
- **Authentication Tokens**: Detects and masks JSON Web Tokens (`[REDACTED_JWT]`).
- **Financial Data**: Identifies and masks 13–19 digit credit and debit card numbers (`[REDACTED_CREDIT_CARD]`).
- **Credentials & Passwords**: Scrubs inline password and secret fields (`[REDACTED_PASSWORD]`).
- **MFA/OTP Codes**: Identifies 6–8 digit one-time verification passcodes (`[REDACTED_MFA_CODE]`).
- **Email Addresses**: Scrubs corporate and personal email addresses (`[REDACTED_EMAIL]`).

### 2. Strict Local-Only Processing Mode (`PRIVACY_MODE=LOCAL`)
When configured in Local Mode or when offline:
- All prompt dispatching routes strictly to local Ollama (`http://localhost:11434`).
- Cloud endpoints (Gemini, OpenAI, Claude, Groq) are blocked at the IPC router level (`ipcMain` throws immediately).
- Cloud Speech-to-Text payload dispatching is rejected.
- Zero bytes of audio, vision, or text leave the user's workstation.

### 3. Ephemeral Volatile-Only Screen Context
- Screenshots captured for visual reasoning are held strictly in ephemeral volatile RAM.
- Persistent saving of raw screenshot image files to disk is permanently disabled.
- In-memory buffers are scrubbed and zero-wiped with zeros (`buf.fill(0)`) immediately after vision/OCR inference to defeat memory dump scraping.

### 4. Hardware-Bound OS Credential Vault
- API credentials are encrypted at rest using Electron's `safeStorage` subsystem:
  - **Windows**: Backed by DPAPI (Data Protection API) tied to the logged-in Windows user account.
  - **macOS**: Backed by Apple Keychain Services.
  - **Linux**: Backed by Secret Service / libsecret or KWallet. Insecure `basic_text` backends are rejected.
- Plaintext API keys never enter renderer state; renderers receive boolean presence indicators only.

### 5. Authenticated AES-256-GCM Session Archive Encryption
- Archived session transcripts and conversation histories saved to disk are protected with authenticated AES-256-GCM encryption (`enc:v1:<iv>:<authTag>:<ciphertext>`).
- Encrypted payloads include cryptographic authentication tags that prevent ciphertext tampering or bit-flipping attacks.
- Supports backward-compatible parsing for existing unencrypted legacy JSON sessions.

### 6. Hardened Electron Runtime Boundary
All desktop windows (`createControlWindow`, `createChatWindow`, `openDashboardWindow`) strictly enforce:
- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`
- Navigation outside trusted application files (`file://` index.html) is denied.
- Window opening (`setWindowOpenHandler`) is denied.
- Dynamic code evaluation (`eval`) is prohibited; IPC arguments undergo strict type and length schema validation.

### 7. Permission Transparency
- Live recording states are prominently displayed in the floating overlay:
  - `🎙 Audio Recording Active`
  - `🖥 Screen Monitoring Active`
  - `🛡️ Local Mode Active`
- Silent or hidden background capture is structurally prevented by design.

### 8. Meeting Privacy Guard & Explicit Audio Consent
System audio loopback capture carries significant confidentiality risks in remote meetings. Cluely enforces explicit consent policies (`meetingConsent`):
- `prompt`: Prompts the user with explicit consent choices before activating loopback audio.
- `allowed_once`: Authorizes loopback capture for the current meeting session only.
- `always_allowed`: Retains user authorization for trusted enterprise environments.
- `denied`: Hard mutes system loopback recording while leaving local microphone transcription optional.

### 9. Outbound Data Inspection & Secret Egress Guard
When operating in Cloud AI mode:
- The egress inspection engine scans outbound request payloads.
- When `blockOutboundSecrets` is enabled, any request containing detected secrets or unredacted credentials is automatically rejected and blocked prior to socket creation.

### 10. Strict Network & TLS 1.3 Transport Security
- Network endpoint validation enforces `https:` for all cloud providers (`generativelanguage.googleapis.com`, `api.openai.com`, `api.anthropic.com`, `api.groq.com`).
- Insecure `http:` connections are rejected, with the sole exception of localhost loopback (`127.0.0.1`, `localhost`, `[::1]`) for local Ollama inference.
- Invalid, expired, or self-signed TLS certificates are rejected via `app.on('certificate-error')`.

### 11. Privacy-First Telemetry Opt-in
- Telemetry is disabled by default (`telemetryEnabled: false`).
- No anonymous diagnostic pings, analytics, audio snippets, or prompts are sent unless the user explicitly opts in via settings.

### 12. Enterprise Compliance Mode (`ENTERPRISE_MODE=true`)
Designed for defense, healthcare, legal, and financial environments:
- Automatically locks inference to local Ollama (`privacyMode = 'local'`).
- Permanently blocks and suppresses all telemetry.
- Disables persistent disk writes for transcripts and session records.
- Enforces strict meeting loopback consent.

---

## Data Purge & Retention Control

- **Logical Data Purge**: Users can delete individual sessions or execute a full cryptographic purge (`purgeAllData`).
- **Vault Clearing**: Purge securely unlinks the encrypted credential vault and session archives.
- **Physical Erasure Notice**: Application purge performs OS-level file deletion. Users requiring forensic erasure against hardware forensic tools should employ OS-level full-disk encryption (BitLocker / FileVault / LUKS).

---

## Disclosure Policy

Vulnerabilities should be reported responsibly following the guidelines outlined in [`SECURITY.md`](../../SECURITY.md).
