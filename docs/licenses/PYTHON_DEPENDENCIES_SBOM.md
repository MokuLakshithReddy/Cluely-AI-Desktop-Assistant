# Python Runtime Inventory and Distribution Notes

This document describes the packages declared for the local RealtimeSTT external-audio runtime. The exact resolved transitive package versions are recorded by the provisioning job in the generated `app/resources/python/PROVISIONED.json` and the CI logs; do not treat this declaration list as a complete transitive SBOM.

## Interpreter

| Item | Value |
|---|---|
| Distribution | Astral `python-build-standalone` install-only |
| CPython | `3.12.16` |
| Release tag | `20261110` |
| Archive selection | Platform and architecture specific, pinned in `scripts/provision-python-runtime.cjs` |
| Integrity | SHA-256 checked before extraction |

## Direct runtime packages

| Package | Version / requirement | Role |
|---|---|---|
| `RealtimeSTT` | `1.2.0` (`--no-deps`) | External-audio recorder, VAD orchestration, and transcription lifecycle |
| `faster-whisper` | `1.2.1` | Whisper inference backend |
| `ctranslate2` | `4.8.0` | CPU inference runtime |
| `silero-vad` | `6.2.3` with `onnx-cpu` extra | Voice activity detection |
| `webrtcvad-wheels` | `2.0.14` | WebRTC VAD |
| `onnxruntime` | `1.32.0` | Silero ONNX execution |
| `numpy` | `2.5.5` | PCM and numerical processing |
| `scipy` | `1.17.1` | Resampling and signal processing |
| `soundfile` | `0.13.1` | Audio-file decode for integration testing and manual-audio helpers |
| `torch` | `2.15.0` | RealtimeSTT initialization and tensor runtime |
| `halo` | `0.0.31` | RealtimeSTT recorder status output dependency |
| `colorama` | `0.4.6` | RealtimeSTT terminal formatting dependency |

## Deliberately excluded microphone stack

`PyAudio`, `PortAudio`, and `torchaudio` are not installed by this Scandium runtime. The application captures system audio in Electron, converts it to mono 16 kHz PCM, and feeds that data to RealtimeSTT using `use_microphone=False`. In RealtimeSTT 1.2.0, the PyAudio import is inside the microphone reader worker, which is not started when microphone capture is disabled.

Changing the sidecar to enable microphone capture invalidates this dependency profile. A separate cross-platform native audio dependency and clean-machine test would be required.

## Security and packaging notes

1. The Python sidecar runs as an unprivileged child process and exchanges newline-delimited JSON messages over standard input/output.
2. Model files are downloaded to the user's application data cache on first use; model downloads are separate from the bundled Python interpreter.
3. Provisioning rejects unsupported platform/architecture combinations and fails if the downloaded interpreter archive does not match its pinned SHA-256.
4. Runtime package resolution is recorded during provisioning. Review the resulting package inventory and each upstream license notice before commercial redistribution; this file alone is not legal advice or a complete license audit.
