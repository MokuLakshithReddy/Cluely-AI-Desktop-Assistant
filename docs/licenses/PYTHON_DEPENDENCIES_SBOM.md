# Python Dependencies Software Bill of Materials (SBOM) & License Compliance

This document provides a verified Software Bill of Materials (SBOM) and license compliance audit for the local speech-to-text runtime (RealtimeSTT + faster-whisper) integrated into Scandium Assistant, generated directly from `app/python-stt/requirements.txt` and the resolved runtime environment.

## Declared Direct Dependencies (`requirements.txt`)

All direct runtime dependencies for the local inference pipeline operate under permissive open-source licenses (Apache-2.0, MIT, BSD-3-Clause). There are zero GPL/AGPL copyleft dependencies or proprietary cloud service requirements, permitting royalty-free, zero-cost commercial distribution.

| Package | Pinned Requirement | Installed / Resolved Version | License | Primary Purpose | Commercial Distribution Permitted |
|---|---|---|---|---|---|
| `RealtimeSTT` | `==1.2.0` | `1.2.0` | Apache-2.0 | Real-time voice activity detection, streaming audio chunk buffer, and transcript callback orchestrator | Yes (Permissive) |
| `faster-whisper` | `==1.2.1` | `1.2.1` | MIT | CTranslate2-accelerated OpenAI Whisper inference engine | Yes (Permissive) |
| `ctranslate2` | `==4.8.0` | `4.8.0` | MIT | Fast CPU/INT8 quantized inference engine optimized for Intel x86_64 AVX2/AVX-512 | Yes (Permissive) |
| `silero-vad` | `==6.2.3` | `6.2.3` | MIT | Deep-learning voice activity detection model for accurate sentence boundary segmentation | Yes (Permissive) |
| `webrtcvad-wheels` | `>=2.0.14` | `2.0.14` | MIT | WebRTC Voice Activity Detector compiled wheels | Yes (Permissive) |
| `onnxruntime` | `>=1.16.0` | `1.32.0` | MIT | Portable runtime for neural network execution | Yes (Permissive) |
| `numpy` | `>=1.24.0` | `2.5.5` | BSD-3-Clause | Vectorized 16-bit PCM buffer conversion and resampling math | Yes (Permissive) |

## Transitive Runtime Dependencies

| Package | Resolved Version | License | Note |
|---|---|---|---|
| `PyAudio` | `0.2.14` | MIT | Audio interface bindings |
| `scipy` | `1.17.1` | BSD-3-Clause | Signal processing filters |
| `torch` | `2.15.0` | BSD-style / Apache-2.0 | Underlying tensor library required by faster-whisper |
| `torchaudio` | `2.11.1` | BSD-2-Clause | Audio waveform operations |
| `tokenizers` | `0.23.3` | Apache-2.0 | HuggingFace byte-pair tokenization |
| `huggingface-hub` | `2.4.0` | Apache-2.0 | Offline model caching utilities |

## Isolation & Security Boundaries

1. **Inter-Process Boundary**: The Python STT engine runs as an isolated unprivileged child process communicating exclusively with Electron via bidirectional NDJSON stdio pipes (`stdin`/`stdout`).
2. **Offline Local Inference**: Speech models (`tiny.en`, `base.en`, `small.en`) are cached in the user's local application data directory. Once fetched, the sidecar operates 100% offline with zero outbound network calls.
3. **No Microphone Access in RealtimeSTT Mode**: System loopback audio (`getDisplayMedia`) is the only audio source captured and fed to the sidecar. The microphone remains idle and disconnected.
4. **Memory Safety & Backpressure**: The Electron-to-Python bridge enforces a strict bounded queue (`MAX_AUDIO_QUEUE = 100`) and halts input during backpressure until the stdin pipe drains.
