# Whisper Runtime Directory

This directory hosts local speech-to-text binaries for Scandium's zero-cost offline transcription pipeline.

## Binary Placement

- **Windows**: `resources/whisper/whisper-cli.exe`
- **macOS**: `resources/whisper/whisper-cli`
- **Linux**: `resources/whisper/whisper-cli`

Prebuilt binaries can be obtained from official [whisper.cpp releases](https://github.com/ggerganov/whisper.cpp/releases).

Models (such as `ggml-tiny.en.bin` ~75MB and `ggml-base.en.bin` ~142MB) are managed and downloaded on-demand with user consent via the **Scandium Dashboard -> Local AI & Hardware** tab, and stored in `%APPDATA%/Scandium/whisper-models/`.
