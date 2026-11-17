# Test Execution Log & Results

**Target Environment**: Windows_NT 10.0.26200 (x64)  
**Node Version**: v24.19.0  
**Test Framework**: Vitest JSON Reporter & Electron UI/IPC E2E Smoke Runner  
**Test Status**: 255/255 Passing (100% Pass Rate)  
**Evidence Source**: Generated directly from automated runner JSON output and process exit verification  
**Source revision**: `3b3fba370914ab2b0aaf973f591594a0fcc85645`  
**Workflow run**: Local execution  
**Verification Date**: 2026-11-17  

---

## Execution Summary

| Test Suite File | Subsystem / Feature Area | Total Tests | Passed | Failed | Status |
|---|---|---|---|---|---|
| `audio-ownership.test.ts` | Dual-Channel Audio Ownership and Capture Lifecycle | 3 | 3 | 0 | **PASSED** |
| `audio-vad.test.ts` | Audio Processing, VAD & Crosstalk Subsystem | 10 | 10 | 0 | **PASSED** |
| `credential-vault.test.ts` | Credential Vault & Secret Protection Subsystem | 14 | 14 | 0 | **PASSED** |
| `device-evidence-validator.test.ts` | device evidence campaign validator | 13 | 13 | 0 | **PASSED** |
| `e2e-desktop-session.test.ts` | Synthetic Desktop Data-Pipeline Integration (Mocked Hardware/Provider Inputs) | 6 | 6 | 0 | **PASSED** |
| `entitlements.test.ts` | Commercial Subscription & Entitlements Matrix | 8 | 8 | 0 | **PASSED** |
| `hardware-detector.test.ts` | Hardware Compatibility Subsystem & Model Recommendation | 7 | 7 | 0 | **PASSED** |
| `ipc-security.test.ts` | IPC Security & Origin Validation Subsystem | 35 | 35 | 0 | **PASSED** |
| `knowledge-rag.test.ts` | Knowledge Base & Document Retrieval (RAG) Subsystem | 12 | 12 | 0 | **PASSED** |
| `license-manager.test.ts` | Lemon Squeezy Licensing & Offline Grace Subsystem | 11 | 11 | 0 | **PASSED** |
| `provider-models.test.ts` | AI Provider Model Propagation and Multi-Turn Serialization | 7 | 7 | 0 | **PASSED** |
| `realtime-stt.test.ts` | RealtimeSTT Local Speech-to-Text Subsystem ($0 Cost Local STT) | 12 | 12 | 0 | **PASSED** |
| `security-redaction.test.ts` | Security, Privacy & Sensitive-Content Hardening Subsystem | 46 | 46 | 0 | **PASSED** |
| `session-archive.test.ts` | Multi-Session Archive & Persistence Subsystem | 12 | 12 | 0 | **PASSED** |
| `state-broadcast.test.ts` | Shared-state renderer broadcast | 2 | 2 | 0 | **PASSED** |
| `state-persistence.test.ts` | State persistence error reporting | 8 | 8 | 0 | **PASSED** |
| `subscription-url.test.ts` | First-party subscription page URLs | 1 | 1 | 0 | **PASSED** |
| `whisper-runtime.test.ts` | Local Speech Recognition (whisper.cpp) Subsystem | 7 | 7 | 0 | **PASSED** |
| `window-coordinator.test.ts` | WindowCoordinator macOS close-all recovery | 6 | 6 | 0 | **PASSED** |
| `ai-context.test.ts` | AI Context Synthesis & Multimodal Provider Subsystem | 14 | 14 | 0 | **PASSED** |
| `ai-streaming.test.ts` | AI Streaming State Resilience Subsystem | 4 | 4 | 0 | **PASSED** |
| `dashboard-routing.test.ts` | Dashboard Route and Hash Parsing | 5 | 5 | 0 | **PASSED** |
| `screen-capture.test.ts` | Screen Capture & Thumbnail Scaling Subsystem | 6 | 6 | 0 | **PASSED** |
| `web-bridge.test.ts` | WebBridge Security and Memory Architecture | 5 | 5 | 0 | **PASSED** |
| `electron-smoke.cjs` | Electron Dashboard UI/IPC E2E Verification | 1 | 1 | 0 | **PASSED** |
| **Total** | **All Core Domains & Electron UI/IPC E2E Verification** | **255** | **255** | **0** | **100% PASS** |

---

## Detailed Verified Test Logs

### 1. Dual-Channel Audio Ownership and Capture Lifecycle (`tests/audio-ownership.test.ts`)
```text
✓ prevents background audio leaks by stopping tracks if cancelled while permission prompt is pending
✓ preserves overlapping microphone and system speech in separate VAD instances
✓ audio owner check prevents multiple windows from creating duplicate hardware streams
```

### 2. Audio Processing, VAD & Crosstalk Subsystem (`tests/audio-vad.test.ts`)
```text
✓ resamples 48kHz audio buffer to 16kHz with correct sample count
✓ calculates RMS energy accurately across float audio frames
✓ calculates Zero-Crossing Rate (ZCR) to distinguish human speech frequencies
✓ detects speech start and speech end with redemption window
✓ preserves simultaneous local and remote speech in independent source pipelines
✓ discards buffered speech without emitting a segment during privacy teardown
✓ keeps approximately 300ms of pre-speech audio with production-sized callbacks
✓ does not retain pre-speech samples when padding is disabled
✓ trims partial oldest callbacks to the exact configured pre-speech sample budget
✓ correctly encodes Float32Array into valid 16-bit PCM WAV with RIFF header
```

### 3. Credential Vault & Secret Protection Subsystem (`tests/credential-vault.test.ts`)
```text
✓ rejects Linux basic_text and unknown backends while accepting OS secret stores
✓ uses asynchronous safeStorage and never calls synchronous encryption methods
✓ fails closed when async safeStorage is temporarily unavailable
✓ re-encrypts decrypted plaintext when Electron reports key rotation
✓ reads existing synchronous safeStorage ciphertext through the async decrypt API
✓ encrypts and successfully decrypts an API key using an explicit test key
✓ fails safely and refuses to persist credentials when async OS keyring is unavailable without a test key
✓ serializes concurrent updates so credentials are not lost
✓ propagates filesystem write errors to caller when persistence fails
✓ returns null when querying a provider that has not been configured
✓ correctly maps hasKeys() boolean presence without exposing secrets
✓ deletes an API key cleanly from vault storage
✓ removes the complete encrypted vault and all provider credentials
✓ rejects empty or non-string key and provider inputs
```

### 4. device evidence campaign validator (`tests/device-evidence-validator.test.ts`)
```text
✓ accepts a complete campaign with every test ID on all release platforms
✓ rejects missing coverage for a release platform
✓ rejects a declared supported device configuration with no evidence run
✓ rejects a run whose platform conflicts with its declared configuration
✓ rejects device metadata that differs from the declared supported configuration
✓ rejects a missing test record within a platform run
✓ rejects duplicate test IDs instead of allowing a record to mask another
✓ requires a traceable SHA-256 digest for every tested package
✓ requires HTTPS evidence for every PASS record
✓ requires a justification for NOT_APPLICABLE and does not count it as PASS
✓ blocks FAIL and BLOCKED records from final sign-off but permits collection mode
✓ allows NOT_RUN records only in collection mode
✓ rejects non-HTTPS evidence links and missing owner sign-off
```

### 5. Synthetic Desktop Data-Pipeline Integration (Mocked Hardware/Provider Inputs) (`tests/e2e-desktop-session.test.ts`)
```text
✓ Stage 1: Checks synthetic audio resampling, independent VAD activity, and WAV header
✓ Stage 2: Checks proportional scaling calculations for synthetic display bounds
✓ Stage 3: Creates an in-memory Markdown fixture and retrieves a matching knowledge passage
✓ Stage 4: Builds a prompt from manually supplied transcript and knowledge context
✓ Stage 5: Parses mocked Gemini SSE and rejects a pre-aborted request
✓ Stage 6: Saves a synthetic session, strips screenshot data, and deletes the repository record
```

### 6. Commercial Subscription & Entitlements Matrix (`tests/entitlements.test.ts`)
```text
✓ correctly maps Free tier restrictions
✓ correctly maps Plus tier capabilities
✓ correctly maps Pro tier capabilities
✓ enforces mode gating across tiers
✓ enforces BYOK provider gating across tiers
✓ enables the developer override only with an explicit flag in an unpackaged non-production build
✓ maps developer override to Pro without altering the underlying licensed tier
✓ keeps client frontend entitlements in exact sync with main process rules
```

### 7. Hardware Compatibility Subsystem & Model Recommendation (`tests/hardware-detector.test.ts`)
```text
✓ detects system hardware profile and provides valid defaults
✓ caches the hardware profile within TTL and dynamic RAM updates
✓ recommends tier-appropriate models for 16GB+ baseline hardware with healthy free RAM
✓ falls back to 1B model when available free RAM is constrained despite 16GB total RAM
✓ recommends lightweight 1B models and warns when RAM is constrained (<8GB)
✓ classifies GPU vendors accurately
✓ prefers physical GPUs over virtual display adapters such as Parsec or RDP
```

### 8. IPC Security & Origin Validation Subsystem (`tests/ipc-security.test.ts`)
```text
✓ accepts exact aggregate document/chunk and AI query limits
✓ rejects one-over aggregate document, chunk, AI query and audio duration limits
✓ rejects aggregate knowledge content and chunk overflow
✓ rejects oversized AI generation context before provider execution
✓ assigns unique main-process operation IDs and rejects duplicate active correlation IDs
✓ rejects invalid renderer correlation IDs
✓ aborts all active provider operations and clears correlation mappings
✓ emergency stop aborts active AI and transcription work without deleting session history
✓ does not re-arm audio capture when emergency stop is invoked during purge
✓ keeps Escape as collapse and exposes a separate emergency stop shortcut
✓ enforces BYOK provider plan tiers and cleans up transcription tasks on stt-transcribe-payload
✓ clears active transcription tasks and controllers when purge-all-data is executed
✓ rejects IPC invocation when senderFrame is null or undefined
✓ rejects IPC invocation when senderFrame.url is empty or invalid
✓ rejects untrusted external website origins (e.g. https://evil-site.com)
✓ rejects lookalike development hostnames attempting prefix or domain spoofing
✓ rejects external URLs attempting to bypass validation via dist/index.html substring
✓ rejects rogue file:// URLs attempting to load dist/index.html from outside the trusted app directory
✓ accepts valid production file:// URL matching the exact trusted app bundle
✓ accepts exact legitimate development server origins (localhost:5173 and 127.0.0.1:5173)
✓ strictly rejects development server origins when running in production mode
✓ respects exact origin when VITE_DEV_SERVER_URL is configured
✓ sanitizes patch-shared-state payloads to only allow whitelisted keys
✓ rejects patch-shared-state payloads containing unwhitelisted or sensitive fields
✓ rejects non-object patch payloads (e.g. strings, arrays, null)
✓ enforces strict boolean types on flags and rejects falsy/truthy non-booleans
✓ validates activeMode against allowed enum variants
✓ validates shortcuts map structure and accelerator strings
✓ validates session structure and rejects invalid session IDs
✓ validates knowledgeDocs structure and document schemas
✓ enforces nested schema validation and size limits on session transcript items
✓ enforces nested schema validation on session chat messages
✓ enforces size limits and schema validation on knowledge documents
✓ sanitizeSessionRecord strips screenshot payloads and enforces a 5MB aggregate size ceiling
✓ validates microphone and system-audio readiness as bounded finite states
```

### 9. Knowledge Base & Document Retrieval (RAG) Subsystem (`tests/knowledge-rag.test.ts`)
```text
✓ chunks documents with overlapping windows respecting paragraph breaks
✓ creates KnowledgeDoc record with correct metadata and chunks
✓ retrieves relevant knowledge passages using smoothed TF-IDF lexical scoring
✓ weights rare query terms more strongly than terms repeated across every chunk
✓ returns empty array when query does not match any document terms
✓ accepts a document at the exact 2 MiB ingestion limit
✓ rejects oversized documents before reading their content
✓ extracts compressed multi-page PDF text and decodes WinAnsi characters
✓ normalizes repeated whitespace and preserves real page separators
✓ returns empty text for a valid PDF page without text operators
✓ rejects malformed PDF data rather than scraping incidental printable bytes
✓ ranks chunks using term frequency and inverse document frequency
```

### 10. Lemon Squeezy Licensing & Offline Grace Subsystem (`tests/license-manager.test.ts`)
```text
✓ generates a stable deterministic hardware fingerprint and anonymous instance name without hostname
✓ defaults to Free tier when no license is configured
✓ fails closed to Free tier when IDs are missing or only product names match
✓ grants paid tiers only for the exact configured product and variant ID pair
✓ expires license immediately if expiresAt date is in the past
✓ activates a license and saves encrypted cache to disk
✓ rejects activation when the license belongs to an unconfigured product
✓ engages 7-day offline grace period on network validation failure
✓ expires license when offline grace period exceeds 7 days
✓ deactivates license and purges local license cache file
✓ preserves cached license across restart and reloads via init() without losing Plus/Pro tier
```

### 11. AI Provider Model Propagation and Multi-Turn Serialization (`tests/provider-models.test.ts`)
```text
✓ streamGemini defaults to gemini-3.6-flash, routes URL correctly and serializes multi-turn history
✓ streamGemini provides diagnostic guidance on 403 / 404 model errors without retrying a different model
✓ streams with the documented Gemini 3.1 Pro Preview model and does not silently fall back
✓ streamOpenAI dynamically forwards gpt-4o-mini and serializes multi-turn turns
✓ streamClaude maps active 2026 models with anthropic-version 2026-10-21 and preserves multi-turn context
✓ streamClaude provides diagnostic error when Claude returns model_not_found error
✓ buildContextPrompt excludes transcribing and error items from transcript context
```

### 12. RealtimeSTT Local Speech-to-Text Subsystem ($0 Cost Local STT) (`tests/realtime-stt.test.ts`)
```text
✓ correctly converts Float32 audio samples into 16-bit signed PCM little-endian buffer
✓ correctly downsamples 48kHz audio to 16kHz for Whisper inference
✓ initializes in synthetic mode and reports status accurately
✓ supports model profile switching between tiny.en, base.en, and small.en
✓ allows subscription to interim, final, and status event listeners
✓ gracefully handles feedAudioChunk and feedSilence without throwing
✓ shuts down cleanly and transitions status to stopped
✓ pauses and resumes transcription state
✓ processes raw PCM audio from jfk.wav fixture and converts to valid 16-bit little-endian chunks
✓ handles model-switch requests without improper coalescing
✓ allows subscription to stabilized event listener
✓ returns model cache info and handles model deletion gracefully
```

### 13. Security, Privacy & Sensitive-Content Hardening Subsystem (`tests/security-redaction.test.ts`)
```text
✓ redacts OpenAI API keys
✓ redacts AWS Access Key IDs
✓ redacts Google API keys
✓ redacts GitHub Personal Access Tokens (PAT)
✓ redacts Slack tokens
✓ redacts Private Keys (RSA, EC, Generic)
✓ redacts JWT tokens
✓ redacts Credit Card numbers
✓ redacts Passwords in text and key-value fields
✓ redacts MFA/OTP authentication codes
✓ redacts Social Security Numbers (SSN)
✓ redacts Email addresses
✓ containsSensitiveData identifies secrets correctly
✓ inspectAndSanitizeOutboundPayload sanitizes deeply nested payloads
✓ inspectAndSanitizeOutboundPayload blocks request when blockOnSecrets is true
✓ wipes sensitive memory buffers with zeroes
✓ parses actual dimensions and masks coordinates dynamically for landscape and portrait images
✓ genuinely masks target pixels to solid black while preserving unmasked pixel values
✓ fails closed when image buffer is corrupted, empty, or truncated
✓ correctly un-filters and masks PNG scanlines across Sub, Up, Average, and Paeth filter types
✓ scans screenshots for arbitrary secrets and automatically masks the workspace region
✓ inspectAndSanitizeOutboundPayload inspects screenshotBase64 and blocks or drops credentials
✓ encrypts session records into authenticated AES-256-GCM envelope
✓ decrypts encrypted session records accurately
✓ detects tampering and rejects corrupted ciphertext via GCM auth tag
✓ maintains backward compatibility with unencrypted legacy JSON
✓ actively migrates all legacy unencrypted plaintext session archives on disk via migrateAllLegacySessions()
✓ guarantees encrypted rewrite when accessing legacy session file and fails closed if write fails
✓ enforces Linux backend allowlist and rejects insecure basic_text
✓ fails closed in production if secure OS-backed storage is unavailable
✓ strictly rejects test key fallback in production even if TEST or SESSION_ENCRYPTION_KEY is set
✓ strictly rejects test key fallback and custom keys when app.isPackaged is true
✓ asynchronously initializes master key via initStorageEncryptionAsync and strictly fails closed in packaged mode
✓ checks async safe storage availability across platforms
✓ accepts HTTPS production endpoints
✓ accepts local loopback HTTP for Ollama offline inference
✓ rejects external insecure HTTP endpoints
✓ rejects invalid URL formats
✓ validates allowed privacy modes
✓ validates allowed meeting consent modes
✓ validates boolean security configuration keys
✓ enforces Enterprise Mode restrictions on state patch
✓ enforces audio channel reset and revokes allowed_once consent when recording stops in main process
✓ blocks cloud screenshot transmission fail-closed when redactSensitiveData is active
✓ blocks unredacted screenshots to external cloud providers when blockOutboundSecrets is active
✓ permits local screenshot processing on-device when provider is local ollama
```

### 14. Multi-Session Archive & Persistence Subsystem (`tests/session-archive.test.ts`)
```text
✓ saves and reads a full session record with transcripts and messages
✓ restricts session directory and archive file access on POSIX
✓ automatically migrates legacy unencrypted session archives to encrypted format on access
✓ lists past sessions ordered by newest creation date
✓ deletes an individual session by identifier
✓ purges all archived sessions cleanly
✓ fails purge when an archive file cannot be deleted
✓ returns null when requesting a nonexistent session id
✓ rejects path traversal attempts in session IDs and protects parent directories
✓ enforces 5MB size ceiling in session repository saveSession
✓ locks repository and rejects access if migrateAllLegacySessions fails to encrypt legacy archives
✓ locks repository and fails closed if getSession encounters a migration re-write error
```

### 15. Shared-state renderer broadcast (`tests/state-broadcast.test.ts`)
```text
✓ updates control, chat, and Dashboard windows
✓ skips missing or destroyed windows without preventing other updates
```

### 16. State persistence error reporting (`tests/state-persistence.test.ts`)
```text
✓ does not restore stale transient persistence warnings from older state files
✓ ignores stale persisted app versions and does not persist runtime version metadata
✓ writes shared-state files with user-only POSIX permissions
✓ surfaces write failures, propagates critical flush errors, and clears the warning after recovery
✓ encrypts shared state at rest with AES-256-GCM envelope and refuses unencrypted writes even if patch attempts to disable
✓ automatically migrates legacy plaintext shared state file to AES-256-GCM encrypted format on load
✓ purges sensitive in-memory state and records persistence error when legacy migration fails
✓ suppresses active session and knowledge documents from disk when enterpriseMode is active
```

### 17. First-party subscription page URLs (`tests/subscription-url.test.ts`)
```text
✓ opens the Scandium pricing page with the selected plan highlighted
```

### 18. Local Speech Recognition (whisper.cpp) Subsystem (`tests/whisper-runtime.test.ts`)
```text
✓ provides verified registry of open-weight GGML Whisper models with exact SHA-256 hashes
✓ tracks active model selection safely
✓ accurately computes SHA-256 file checksums via streaming digest
✓ returns clean diagnostic message when attempting transcription with uninstalled model
✓ returns clean diagnostic message when model exists but whisper binary is missing
✓ launches native whisper-cli and transcribes known audio sample with high fidelity
✓ gracefully serializes concurrent overlapping audio streams without crashing or process starvation
```

### 19. WindowCoordinator macOS close-all recovery (`tests/window-coordinator.test.ts`)
```text
✓ clears closed control/chat references and recreates both windows on reinitialization
✓ keeps initialization idempotent and does not register duplicate state listeners
✓ returns null for destroyed windows even before their closed event is delivered
✓ moveControlWindow rounds fractional coordinates and syncs visible chat window
✓ moveControlWindow does not reposition chat window when chat is hidden
✓ moveControlWindow safely ignores invalid or NaN deltas
```

### 20. AI Context Synthesis & Multimodal Provider Subsystem (`tests/ai-context.test.ts`)
```text
✓ builds context prompt including speaker-attributed transcripts
✓ filters out error and incomplete transcript segments from prompt context
✓ includes mode-specific system prompts with clear operational boundaries
✓ integrates retrieved knowledge passages with clear source tagging
✓ handles empty query gracefully with contextual default instruction
✓ verifies system prompt presence across all 5 defined assistance modes
✓ formats user request cleanly when query contains multiline strings
✓ strips Context description and Draft Response headers to return only direct solutions
✓ strips markdown **Context:** blocks and returns the direct answer
✓ leaves direct solutions completely untouched
✓ strips standalone Draft Response: or Suggested Response: prefixes
✓ strips bulleted Context and Draft Response preambles cleanly
✓ strips dashed Context and Answer preambles cleanly
✓ hides incomplete context preamble while streaming so it does not flicker on screen
```

### 21. AI Streaming State Resilience Subsystem (`tests/ai-streaming.test.ts`)
```text
✓ accumulates 50 consecutive streamed tokens without dropping prior user message or earlier tokens
✓ preserves multi-turn conversation history across multiple consecutive queries
✓ gracefully handles user cancellation by marking generation stopped while retaining accumulated content
✓ guarantees state immutability when updating session records
```

### 22. Dashboard Route and Hash Parsing (`tests/dashboard-routing.test.ts`)
```text
✓ parses empty or missing hash as default "all" view
✓ parses direct routes without query parameters
✓ correctly extracts route and tab query parameters from complex hashes
✓ handles leading slash with query parameters
✓ normalizes valid tabs, common aliases, and unknown tab names safely without blank panels
```

### 23. Screen Capture & Thumbnail Scaling Subsystem (`tests/screen-capture.test.ts`)
```text
✓ passes unscaled bounds when screen resolution <= 1920x1080
✓ scales 4K display (3840x2160) proportionally to 1920x1080 (0.5x ratio)
✓ scales ultra-wide display (3440x1440) proportionally capped at 1920
✓ preserves aspect ratio when height is greater than width (portrait display)
✓ handles boundary 1x1 minimal screen dimension safely
✓ prefers the exact display match when non-empty and falls back past empty virtual displays
```

### 24. WebBridge Security and Memory Architecture (`tests/web-bridge.test.ts`)
```text
✓ stores API keys ephemerally in-memory and NEVER persists them to localStorage
✓ purgeAllData wipes in-memory vault keys and stored session archives
✓ rejects screen capture when mediaDevices.getDisplayMedia is rejected and does not fabricate canvas images
✓ abortAiStream returns false for unknown requestId without aborting other requests
✓ exposes window lifecycle controls minimizeApp and quitApp safely
```

### 25. Electron UI/IPC E2E Verification (`tests/electron-smoke.cjs`)
```text
✓ Spawns Electron with ELECTRON_RUN_AS_NODE removed
✓ Loads the control/chat windows and mounts the real Dashboard renderer
✓ Exercises credential save/delete and native purge-all-data through the Dashboard/preload/IPC path (vault check when safeStorage is available)
✓ Exercises session save/list/get/delete and archive purge against the disk-backed repository
✓ Verifies graceful shutdown lifecycle ([APP_CLEAN_SHUTDOWN], [APP_BEFORE_QUIT], [APP_WILL_QUIT])
✓ Confirms [E2E_COMPLETE] and a normal exit (code 0, signal null)
⚠ Physical microphone, system-audio loopback, active-display capture, and live provider networking remain manual/device-dependent tests
```
