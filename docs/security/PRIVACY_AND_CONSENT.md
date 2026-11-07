# Privacy, Consent, and Data Governance

## Product principle

Cluely Copilot is intended to be a user-controlled desktop assistant. Audio capture, screen context, documents, chat history, and provider credentials can be sensitive. Users must understand when capture is active, where data is processed, and what a local purge can and cannot remove.

## Consent and user control

- Start microphone and system-audio capture only through an explicit user action in the application.
- Keep clear visual capture/voice-activity indicators visible while capture is active.
- Provide a dedicated emergency-stop control that stops capture and aborts active AI/STT work.
- The Escape key collapses the chat UI; it is not the emergency-stop action.
- Users are responsible for obtaining participant consent and complying with local recording laws, organizational policies, and meeting rules before capturing conversations.

The application implements user controls and indicators, but software cannot establish that every participant has consented. Do not use the app to conduct covert recording.

## Processing and data flows

| Data | Application behavior | External processing |
|---|---|---|
| Microphone audio | In-memory capture and VAD processing | Speech segments are sent to the configured STT provider |
| System/meeting audio | Separate in-memory capture and VAD pipeline | Speech segments are sent to the configured STT provider |
| Screenshot | Captured in response to visual-context action | May be sent to the selected AI provider |
| Documents | Parsed and indexed in local knowledge storage | Retrieved context may be included in a user-initiated AI request |
| Chat and transcript | Maintained in app state and session archive | Relevant context may be included in AI requests |
| Provider API keys | Stored in the desktop credential vault | Sent to the chosen provider for authenticated requests |

Cloud providers process the payloads they receive according to their own terms, policies, and account settings. Cluely Copilot cannot guarantee deletion from third-party provider systems.

## Credential storage

Desktop credentials are encrypted with Electron `safeStorage` using the OS-backed provider. Linux basic-text and unknown backends are rejected. Raw credentials are kept out of renderer shared-state broadcasts.

The audited source revision still uses synchronous `safeStorage` calls. The asynchronous migration and compatibility testing for existing stored credentials remain tracked in [issue #19](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/19). AES test-key encryption is not a production fallback.

## Retention and deletion

- Audio samples used by the live capture pipeline are processed in memory and are not intentionally added to archived session records.
- Screenshot base64 content is stripped from saved message records.
- Session archives, local knowledge data, and the credential vault are stored under the application user-data area.
- The purge command removes application-managed archives and the vault and requests teardown of active capture/transcription work.

Purge is logical application-level deletion, not certified forensic erasure. It cannot remove backups, filesystem snapshots, OS-level remnants, exported files, provider copies, or data outside the app's control.

## Display protection

The optional Electron content-protection setting asks the operating system to exclude protected app windows from supported capture paths. The behavior varies by operating system and capture API. It is not a guarantee against every screen recorder, administrator-controlled capture method, remote desktop, external camera, or hardware capture device.

## Testing and release evidence

Automated tests include unit/integration coverage and a desktop Dashboard/preload/IPC smoke. Active-capture purge testing uses fake media sources. Physical device, permission, live provider, and packaged-app launch verification are separate release gates; see [issue #49](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/49) and [issue #48](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/issues/48).
