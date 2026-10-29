# Privacy, Consent & Data Governance Framework

**Document Version**: 1.0.0  
**Target Application**: Cluely Copilot (Desktop AI Assistant)  
**Effective Date**: October 2026  
**Status**: **OFFICIAL PRODUCT GOVERNANCE SPECIFICATION**

---

## 1. Core Philosophy: Consent as a Product Feature

In professional engineering, technical consultation, and collaborative workplace environments, an AI desktop assistant cannot succeed without **absolute transparency and earned trust**. Covert recording tools create severe legal liability, breach workplace policies, and destroy peer relationships.

Cluely Copilot is designed from the ground up as a **transparent, consent-first desktop copilot**. Privacy and consent are not afterthoughts or compliance burdens—they are primary architectural features of the product.

```
+-----------------------------------------------------------------------------------+
|                        TRANSPARENT CLIENT WORKSTATION                             |
|                                                                                   |
|  [Prominent Indicator] 🔴 Active Meeting Capture (Visible to User at all times)  |
|                                                                                   |
|  [Volatile RAM Buffer] Audio frames in memory -> VAD -> STT -> Immediately Purged |
|                                                                                   |
|  [Hardware DPAPI Vault] API Keys encrypted via Windows DPAPI / macOS Keychain      |
|                                                                                   |
|  [Zero Disk Leaks] Base64 Screenshots stripped prior to session JSON persistence   |
|                                                                                   |
|  [Zero Central Server] NO Cluely cloud backend, NO proxies, NO telemetry beacons  |
+-----------------------------------------------------------------------------------+
                                         │ Direct BYOK HTTPS Calls
                                         ▼
                   [Official AI Provider APIs (Google, Groq, Anthropic)]
```

---

## 2. Real-Time Visual Capture Indicators & Controls

1. **Persistent Visual State**:
   * Whenever audio capture is initiated, the floating assistant bar immediately displays an unambiguous high-visibility indicator:
     $$\text{Status: } \mathbf{\color{red}\bullet\ Active\ Meeting\ Capture}$$
   * The audio visualizer animates in real time, showing distinct activity for the user's microphone (cyan pulse) and system loopback (purple pulse).
2. **No Stealth or Covert Background Recording**:
   * Audio capture is **never** started silently on application launch or background startup.
   * Audio capture requires explicit user activation via the microphone toggle or the user-defined global hotkey (`Alt+S` / `Ctrl+Shift+X`).
3. **Instant Stop & Emergency Mute**:
   * An immediate "Stop Listening" button is accessible at all times on the floating bar.
   * Pressing `Escape` or the mute hotkey instantaneously tears down media capture tracks within **<20 milliseconds**.
4. **Meeting Participant Notification & Consent Guidance**:
   * Users operating in two-party or multi-party consent jurisdictions (e.g. California, Illinois, Germany) must obtain agreement from all call participants before enabling audio processing.
   * Cluely Copilot provides a standard recommended notice:
     > *"I am using an AI copilot to assist with transcription and technical runbook retrieval during our discussion."*

---

## 3. Data Boundary & Transmission Architecture

### Zero Central Cluely Servers or Intermediary Proxies
* **No Middleman Server**: Cluely Technologies does not maintain an intermediary cloud service, proxy gateway, logging server, or tracking database.
* **Direct BYOK Communication**: All speech-to-text and language model inferences travel **directly** from the user's workstation over encrypted TLS 1.3 connections to the AI provider endpoint configured by the user (Google Gemini, OpenAI, Anthropic, Groq, or a completely offline local model via Ollama).
* **Zero Telemetry**: The codebase contains **zero tracking pixels, zero analytics SDKs (e.g., Mixpanel, Segment, Google Analytics), and zero crash-reporting pings**.

### Ephemeral Audio Processing
* **Volatile Memory Only**: Incoming microphone and loopback audio frames are held strictly in temporary `Float32Array` circular buffers in volatile system RAM.
* **Instant Deletion**: The instant a speech segment is packaged into a 16-bit PCM RIFF WAV buffer and dispatched to the STT API, the raw audio buffer is unreferenced and reclaimed by garbage collection.
* **Zero Raw Audio on Disk**: At no point is raw audio written to the workstation's hard drive or SSD.

### Visual Context & Screenshot Base64 Stripping
* **User-Triggered Screen Capture**: Screen captures are captured solely when the user requests multimodal guidance (`Ctrl+Enter` or "Ask AI with Screen").
* **Transient API Context**: The screenshot is downscaled to a max dimension of 1920px in memory, attached to the outbound LLM request, and immediately released.
* **Disk Persistence Guard**: In `session-repository.ts`, before any session archive is written to `userData/sessions/*.json`, the `screenshot` property is explicitly stripped:
  ```typescript
  const sanitizedMessages = session.messages.map(({ screenshot, ...rest }) => rest);
  ```
  This guarantees that saved conversation histories remain tiny (~4 KB text files) and cannot leak desktop display imagery to disk.

---

## 4. Hardware-Backed Credential Security

API keys grant access to billable cloud resources and must be guarded against extraction by other software on the workstation:

* **Desktop Environment (Electron SafeStorage)**:
  * API keys are encrypted using **Windows Data Protection API (DPAPI)** on Windows and **Keychain Services** on macOS.
  * Encrypted keys are stored in `userData/credentials.vault` using authenticated AES-256-GCM.
  * Keys are bound to the specific user profile and machine hardware.
  * **Fail-Safe Policy (`safeFail`)**: If hardware-backed secure storage is unavailable, key writes are rejected rather than falling back to unencrypted disk storage.
  * Plaintext keys are never shared across IPC or exposed in renderer browser state.
* **Browser Preview Environment (Web Bridge)**:
  * For web preview mode, credentials reside purely in ephemeral JavaScript heap memory (`inMemoryVaultKeys`).
  * Credentials are **never written to browser `localStorage` or `sessionStorage`**.
  * Closing or refreshing the browser tab instantly obliterates all credentials from memory.

---

## 5. Overlay Display Affinity (`setContentProtection`)

Cluely Copilot provides a user toggle for Display Protection / Overlay Affinity (`win.setContentProtection(true)`):

* **Purpose**: In professional presentation settings, users frequently share their entire desktop. Window content protection sets the Win32 `WDA_EXCLUDEFROMCAPTURE` affinity flag.
* **Functional Benefit**: This ensures the assistant's floating window and private notes do not appear inside **Zoom**, **Microsoft Teams**, **Google Meet**, or **WebEx** screen shares, keeping the presenter's personal notes private from attendees.
* **Transparency Boundary**: This setting does not bypass operating system accessibility hooks, enterprise screen monitors, or hardware video capture devices (e.g. HDMI splitters).

---

## 6. Complete Data Sovereignty: One-Click Data Purge

Users retain total ownership and control over their stored data. At any time, navigating to **Dashboard → Session Manager** or calling the IPC endpoint `purge-all-data` triggers an exhaustive disk and memory wipe:

1. **Session Archives**: All `.json` session history files in `userData/sessions/` are deleted from disk.
2. **Knowledge Documents**: In-memory document chunk indices, TF-IDF vector tables, and parsed PDF tokens are deallocated.
3. **Active State**: In-memory transcript items and message histories are reset to empty arrays (`[]`).
4. **Credential Purge**: User-specified option to clear all hardware-stored DPAPI vault keys.
5. **No Residual State**: The application returns to a clean-install state with zero residual logs or cache artifacts.
