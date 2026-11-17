#!/usr/bin/env python3
"""Exercise RealtimeSTT's real external-audio path with a known speech fixture."""

from __future__ import annotations

import os
import sys
import threading
import time
import wave
from pathlib import Path

from huggingface_hub import snapshot_download
from RealtimeSTT import AudioToTextRecorder

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "jfk.wav"
MODEL_REPO = "Systran/faster-whisper-tiny.en"
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

    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    model_cache = hf_home / "hub"
    model_cache.mkdir(parents=True, exist_ok=True)

    timer = threading.Timer(TIMEOUT_SECONDS, abort_on_timeout)
    timer.daemon = True
    timer.start()

    recorder = None
    try:
        print(
            f"[RealtimeSTTIntegration] Ensuring {MODEL_REPO} is cached in {model_cache}.",
            flush=True,
        )
        snapshot_download(repo_id=MODEL_REPO, cache_dir=str(model_cache))
        print("[RealtimeSTTIntegration] Whisper model cache is ready.", flush=True)

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
                # Avoid a second default "tiny" model download and keep the CI
                # runtime representative of the app's single-model CPU profile.
                use_main_model_for_realtime=True,
                download_root=str(model_cache),
                silero_use_onnx=True,
                silero_backend="onnx",
                silero_deactivity_detection=True,
                on_vad_start=lambda: print(
                    "[RealtimeSTTIntegration] VAD_START", flush=True
                ),
                on_vad_stop=lambda: print(
                    "[RealtimeSTTIntegration] VAD_STOP", flush=True
                ),
                allowed_latency_limit=1000,
                post_speech_silence_duration=0.6,
                min_length_of_recording=0.5,
                beam_size=1,
            )
            print(
                "[RealtimeSTTIntegration] Recorder initialized; feeding system-audio PCM.",
                flush=True,
            )

            # Feed real audio as bounded 100 ms PCM chunks, pacing input like a
            # live loopback stream instead of overwhelming the VAD input queue.
            while True:
                pcm_chunk = audio.readframes(1600)
                if not pcm_chunk:
                    break
                recorder.feed_audio(pcm_chunk, original_sample_rate=sample_rate)
                time.sleep(len(pcm_chunk) / (sample_rate * sample_width))

            # Explicit trailing silence lets VAD close the final utterance.
            recorder.feed_audio(
                b"\x00\x00" * sample_rate,
                original_sample_rate=sample_rate,
            )

        # RealtimeSTT 1.2.0 buffers partial manual-input chunks. Flush the final
        # remainder and wait for the recording worker to consume all queued PCM
        # before asking for the finalized transcript.
        recorder.flush_audio_input()
        print("[RealtimeSTTIntegration] Waiting for queued audio to drain.", flush=True)
        if not recorder.drain_audio_input(timeout=60):
            raise TimeoutError("RealtimeSTT did not drain the queued audio within 60 seconds.")

        print("[RealtimeSTTIntegration] Audio queue drained; waiting for final transcript.", flush=True)
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
