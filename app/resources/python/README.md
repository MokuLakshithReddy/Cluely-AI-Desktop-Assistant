# Scandium Portable Python Runtime

This directory is populated at packaging time with an app-local CPython 3.12.16 install-only distribution from Astral's `python-build-standalone` project.

`scripts/provision-python-runtime.cjs` downloads the platform-specific archive, verifies its pinned SHA-256 digest, installs the requirements in `app/python-stt/requirements.txt`, then installs `RealtimeSTT==1.2.0` with `--no-deps` and runs import checks in a scrubbed environment.

Scandium supplies system-loopback PCM to RealtimeSTT and always constructs `AudioToTextRecorder` with `use_microphone=False`. PyAudio and PortAudio are intentionally omitted because they are only used by RealtimeSTT's microphone input worker. Do not enable microphone capture in this sidecar without adding and packaging a supported native audio backend.

The generated `PROVISIONED.json` records the standalone interpreter archive, SHA-256, target platform, and verification result. Run `node scripts/provision-python-runtime.cjs` before building or packaging.
