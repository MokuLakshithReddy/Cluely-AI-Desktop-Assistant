# Python Dependencies Software Bill of Materials (SBOM) & License Compliance

This document provides a verified Software Bill of Materials (SBOM) and license compliance audit for the local speech-to-text runtime (RealtimeSTT + faster-whisper) integrated into Scandium Assistant.

## Zero-Cost Commercial License Compliance Matrix

All bundled and referenced Python libraries for the RealtimeSTT local inference pipeline operate under permissive open-source licenses (MIT, BSD-3-Clause, Apache-2.0). There are zero GPL/AGPL copyleft dependencies or proprietary cloud API dependencies, enabling completely royalty-free, zero-cost commercial distribution.

| Package | Version | License | Primary Purpose | Commercial Distribution Permitted |
|---|---|---|---|---|
| `RealtimeSTT` | `0.3.5` | MIT | Real-time voice activity detection, streaming audio chunk buffer, and transcript callback orchestrator | Yes |
| `faster-whisper` | `1.1.1` | MIT | CTranslate2-accelerated OpenAI Whisper inference engine | Yes |
| `ctranslate2` | `4.8.0` | MIT | Fast CPU/INT8 quantized inference engine optimized for Intel x86_64 AVX2/AVX-512 | Yes |
| `silero-vad` | `6.2.3` | MIT | Deep-learning voice activity detection model for accurate sentence boundary segmentation | Yes |
| `onnxruntime` | `1.20.1` | MIT | Portable runtime for Silero VAD neural network execution | Yes |
| `numpy` | `>=1.24.0` | BSD-3-Clause | Vectorized 16-bit PCM buffer conversion and resampling math | Yes |
| `scipy` | `>=1.10.0` | BSD-3-Clause | Digital signal processing filters | Yes |
| `pyaudio` | `0.2.14` | MIT | Audio I/O abstraction (fallback) | Yes |
| `torch` | `>=2.0.0` | BSD-3-Clause | Underlying tensor operations required by faster-whisper and silero-vad | Yes |
| `torchaudio` | `>=2.0.0` | BSD-3-Clause | Audio waveform tensors and filterbanks | Yes |

## Isolation & Security Boundaries

1. **Inter-Process Boundary**: The Python STT engine runs as an isolated unprivileged child process communicating exclusively with Electron via bidirectional NDJSON stdio pipes (`stdin`/`stdout`).
2. **Offline Local Inference**: Speech models (`tiny.en`, `base.en`, `small.en`) are cached in the user's local application data directory. Once fetched, the sidecar operates 100% offline with zero outbound network calls.
3. **No Microphone Access in RealtimeSTT Mode**: System loopback audio (`getDisplayMedia`) is the only audio source captured and fed to the sidecar. The microphone remains idle and disconnected.
4. **Memory Safety & Backpressure**: The Electron-to-Python bridge enforces a strict bounded queue (`MAX_AUDIO_QUEUE = 100`) and halts input during backpressure until the stdin pipe drains.
