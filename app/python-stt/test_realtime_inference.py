#!/usr/bin/env python3
"""Exercise the real RealtimeSTT external-audio path with a known speech fixture."""

from __future__ import annotations

import os
import sys
import threading
import wave
from pathlib import Path

from RealtimeSTT import AudioToTextRecorder

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "jfk.wav"
TIMEOUT_SECONDS = 300


def abort_on_timeout() -> None:
    print(
        f"[RealtimeSTTIntegration] Timed out after {TIMEOUT_SECONDS}s.",
        file=sys.stderr,
        flush=True,
    )
    os._exit(124)


def main() -> int:
    if not FIXTURE.is_file():
        raise FileNotFoundError(f"Required speech fixture is missing: {FIXTURE}")

    timer = threading.Timer(TIMEOUT_SECONDS, abort_on_timeout)
    timer.daemon = True
    timer.start()

    recorder = None
    try:
        with wave.open(str(FIXTURE), "rb") as audio:
            channels = audio.getnchannels()
            sample_width = audio.getsampwidth()
            sample_rate = audio.getframerate()
            frame_count = audio.getnframes()

            if channels != 1 or sample_width != 2 or sample_rate != 16000:
                raise AssertionError(
                    "JFK fixture must be mono, signed 16-bit PCM at 16 kHz; "
                    f"got channels={channels}, sample_width={sample_width}, "
                    f"sample_rate={sample_rate}"
                )

            print(
                "[RealtimeSTTIntegration] Initializing CPU INT8 RealtimeSTT "
                f"with {frame_count} fixture frames.",
                flush=True,
            )
            recorder = AudioToTextRecorder(
                model="tiny.en",
                language="en",
                device="cpu",
                compute_type="int8",
                use_microphone=False,
                spinner=False,
                enable_realtime_transcription=True,
                silero_use_onnx=True,
                silero_backend="onnx",
                allowed_latency_limit=1000,
                post_speech_silence_duration=0.6,
                min_length_of_recording=0.5,
                beam_size=1,
            )

            # Feed real audio as bounded 100 ms PCM chunks, exactly as the Electron
            # sidecar does for system-loopback audio.
            while True:
                pcm_chunk = audio.readframes(1600)
                if not pcm_chunk:
                    break
                recorder.feed_audio(pcm_chunk, original_sample_rate=sample_rate)

            # Explicit trailing silence lets the VAD close the final utterance.
            recorder.feed_audio(
                b"\x00\x00" * sample_rate,
                original_sample_rate=sample_rate,
            )

        transcript = recorder.text()
        transcript = " ".join((transcript or "").split())
        print("[RealtimeSTTIntegration] Transcript:", transcript, flush=True)

        if len(transcript) < 20:
            raise AssertionError(
                "RealtimeSTT returned an empty or implausibly short transcript."
            )
        if "country" not in transcript.lower() and "americans" not in transcript.lower():
            raise AssertionError(
                "Transcript did not contain expected JFK fixture content: " + transcript
            )

        print("[RealtimeSTTIntegration] REAL_AUDIO_TRANSCRIPTION_PASSED", flush=True)
        return 0
    finally:
        timer.cancel()
        if recorder is not None:
            try:
                recorder.shutdown()
            except Exception as exc:
                print(
                    "[RealtimeSTTIntegration] Recorder shutdown warning:",
                    str(exc),
                    file=sys.stderr,
                    flush=True,
                )


if __name__ == "__main__":
    raise SystemExit(main())
