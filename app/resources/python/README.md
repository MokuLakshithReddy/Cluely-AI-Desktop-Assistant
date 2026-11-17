# Scandium Portable Python Runtime

This directory contains the embedded, relocatable CPython 3.12.16 runtime and the installed
RealtimeSTT / faster-whisper dependencies used by the packaged Electron application.

The runtime is downloaded from the checksum-pinned
[python-build-standalone 20261110 release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261110).
The provisioning script verifies the archive SHA-256 before extracting or installing packages.

Run `node scripts/provision-python-runtime.cjs` from the repository root to populate this
directory before packaging. Do not replace this distribution with a regular `venv`: a venv
may refer back to the Python installation on the machine that created it.

On Linux and macOS, the provisioning script bundles PortAudio beside the PyAudio extension
and rewrites the native loader path to be relative to that extension. The PortAudio MIT
notice is included beside the PyAudio runtime.
