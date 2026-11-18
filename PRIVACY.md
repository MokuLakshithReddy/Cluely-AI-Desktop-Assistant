# Scandium Privacy Policy & Data Architecture

Scandium is designed with a strict **Privacy-First & Local-First Architecture**. We believe your desktop workflow, voice conversations, documents, and screen contents belong exclusively to you.

---

## 1. Zero Owner-Side Data Collection

Scandium operates with **$0 owner backend infrastructure**:
- We do **not** run centralized inference servers, voice gateways, or tracking telemetry backends.
- We do **not** log, ingest, inspect, store, or sell your screen captures, audio transcripts, or prompt queries.
- All session history, knowledge documents, and settings are stored locally on your device in authenticated encrypted envelopes (AES-256-GCM).

---

## 2. Execution Modes & Data Flow

### A. Local AI Mode (Default)
- **Speech Recognition**: Transcribed locally via `whisper.cpp` executing entirely on your CPU / local hardware.
- **Language & Vision Models**: Processed through local runtimes (such as Ollama) over `localhost:11434`.
- **Perimeter Guarantee**: In Local AI Mode, **zero audio packets, zero screen pixels, and zero prompt text** are transmitted across the internet.

### B. Bring-Your-Own-Key (BYOK) Cloud AI Mode (Optional)
- Customers may choose to connect their personal API credentials (e.g. Google Gemini, OpenAI, Anthropic, Groq).
- Transmissions originate directly from your machine to the chosen provider's official API endpoints.
- Credentials are encrypted at rest using OS hardware keychains (Windows DPAPI, macOS Keychain, Linux Secret Service).
- You remain in full control of your relationship and billing with your chosen cloud providers.

---

## 3. Two-Party Audio & Screen Consent Notice

Scandium provides real-time audio and screen contextual understanding capabilities.
- **Audio Recording Consent**: Users are responsible for complying with applicable wiretapping, recording, and privacy laws in their jurisdiction (including two-party or all-party consent states/countries) before activating microphone or system audio capture during multi-party calls or meetings.
- **Sensitive Text Redaction**: Scandium automatically sanitizes passwords, API keys (OpenAI, Anthropic, Gemini, AWS, Slack, GitHub), cryptographic private keys, bearer tokens, credit cards, Social Security Numbers (SSNs), and emails from user prompts, conversation histories, transcripts, and notes prior to model dispatch.
- **Screen Capture Privacy & Local-First Boundaries**: Scandium inspects screenshot metadata and embedded text chunks for sensitive credentials, provides coordinate/region overlay masking, and applies a strict fail-closed outbound block when sensitive strings are detected. Because Scandium does not perform arbitrary pixel-level optical character recognition (OCR) across full desktop rasters, users should keep sensitive windows obscured or enable **Local AI Mode** (where desktop screenshots are processed exclusively on `localhost` and never leave your computer).

---

## 4. Licensing & Transaction Data

Payment processing and subscription billing are managed by our Merchant of Record, **Lemon Squeezy**:
- Billing details, credit card numbers, and invoices are processed directly by Lemon Squeezy under their security and privacy policies.
- Scandium validates subscription status using Lemon Squeezy's public License API (`/validate`, `/activate`) transmitting only your license key and a non-reversible SHA-256 hardware hash (`Scandium-<platform>-<hash>`) derived strictly from coarse non-PII hardware traits (OS platform, CPU architecture, CPU model, CPU core count, and total memory). Your personal computer hostname is never read for, hashed into, transmitted with, or logged by licensing requests.

---

## 5. Local Data Purge

You can permanently delete all local sessions, encrypted archives, and cached credentials at any time by selecting **Purge All Data** in the Scandium Dashboard settings.
