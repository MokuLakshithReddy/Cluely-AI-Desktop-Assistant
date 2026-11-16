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
- **Screen Capture Awareness**: Scandium provides automatic client-side sensitive content redaction (filtering credit cards, social security numbers, and bearer tokens), but users should remain mindful of sensitive or confidential material visible on screen.

---

## 4. Licensing & Transaction Data

Payment processing and subscription billing are managed by our Merchant of Record, **Lemon Squeezy**:
- Billing details, credit card numbers, and invoices are processed directly by Lemon Squeezy under their security and privacy policies.
- Scandium validates subscription status using Lemon Squeezy's public License API (`/validate`, `/activate`) transmitting only your license key and an anonymous, non-reversible hardware hash (`Scandium-<hostname>-<hash>`).

---

## 5. Local Data Purge

You can permanently delete all local sessions, encrypted archives, and cached credentials at any time by selecting **Purge All Data** in the Scandium Dashboard settings.
