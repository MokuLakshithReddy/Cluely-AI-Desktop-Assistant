#!/usr/bin/env python3
"""
Scandium Assistant - Realtime Speech-to-Text Sidecar
Powered by RealtimeSTT + faster-whisper.
Runs local CPU INT8 inference for system audio loopback capture.
"""

import sys
import json
import base64
import os
import time
import threading
import traceback

# Force unbuffered UTF-8 output on standard streams
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)

MAX_LINE_LENGTH = 2 * 1024 * 1024  # 2 MiB maximum protocol line
MAX_AUDIO_CHUNK_BYTES = 512 * 1024  # 512 KiB maximum base64 audio payload

def current_time_ms():
    """Return current Unix timestamp in integer milliseconds."""
    return int(time.time() * 1000)

def emit(obj):
    """Emit JSON message over stdout followed by a newline."""
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    except Exception as e:
        sys.stderr.write(f"[Sidecar] Failed to emit message: {e}\n")

# Defensive compatibility shim: PyAV >= 14 removed metadata_errors="ignore" argument, which
# faster-whisper's decode_audio passes. Patch av.open if needed so any audio container loads smoothly.
try:
    import av
    if not hasattr(av, '_orig_open'):
        _orig_av_open = av.open
        def _patched_av_open(*args, **kwargs):
            try:
                return _orig_av_open(*args, **kwargs)
            except TypeError:
                kwargs.pop('metadata_errors', None)
                return _orig_av_open(*args, **kwargs)
        av.open = _patched_av_open
        av._orig_open = _orig_av_open
except Exception:
    pass

class ScandiumSTTEngine:
    def __init__(self):
        self.recorder = None
        self.running = False
        self.is_paused = False
        self.worker_thread = None
        self.stop_event = threading.Event()
        self.model_name = "tiny.en"
        self.download_root = None

    def initialize(self, model_name="tiny.en", download_root=None):
        safe_models = {"tiny.en", "base.en", "small.en", "medium.en"}
        if model_name not in safe_models:
            model_name = "tiny.en"

        self.model_name = model_name
        self.download_root = download_root

        # Check if model appears to exist locally or needs downloading
        is_cached = False
        if self.download_root and os.path.isdir(self.download_root):
            try:
                for entry in os.listdir(self.download_root):
                    if self.model_name in entry:
                        is_cached = True
                        break
            except Exception:
                pass

        if not is_cached:
            emit({
                "type": "status",
                "status": "downloading",
                "model": self.model_name,
                "message": f"Downloading model {self.model_name}...",
                "timestamp": current_time_ms()
            })

        emit({
            "type": "status",
            "status": "initializing",
            "model": self.model_name,
            "message": f"Loading model {self.model_name}...",
            "timestamp": current_time_ms()
        })

        try:
            from RealtimeSTT import AudioToTextRecorder

            def on_interim(text):
                if text and text.strip() and not self.is_paused and self.running:
                    emit({
                        "type": "interim",
                        "text": text.strip(),
                        "timestamp": current_time_ms()
                    })

            def on_stabilized(text):
                if text and text.strip() and not self.is_paused and self.running:
                    emit({
                        "type": "stabilized",
                        "text": text.strip(),
                        "timestamp": current_time_ms()
                    })

            # Clean up any existing recorder
            if self.recorder:
                try:
                    self.shutdown()
                except Exception:
                    pass

            self.stop_event.clear()
            self.running = True
            self.is_paused = False

            # RealtimeSTT CPU INT8 configuration optimized for Intel CPU
            self.recorder = AudioToTextRecorder(
                model=self.model_name,
                language="en",
                device="cpu",
                compute_type="int8",
                use_microphone=False,
                spinner=False,
                enable_realtime_transcription=True,
                allowed_latency_limit=1000,
                silero_use_onnx=True,
                silero_backend="onnx",
                download_root=self.download_root,
                post_speech_silence_duration=0.6,
                min_length_of_recording=0.5,
                on_realtime_transcription_update=on_interim,
                on_realtime_transcription_stabilized=on_stabilized,
            )

            self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
            self.worker_thread.start()

            emit({
                "type": "status",
                "status": "ready",
                "model": self.model_name,
                "message": f"RealtimeSTT initialized with model {self.model_name}.",
                "timestamp": current_time_ms()
            })
            return True
        except Exception as e:
            err_msg = f"Initialization error: {str(e)}"
            sys.stderr.write(f"[Sidecar] {err_msg}\n{traceback.format_exc()}\n")
            emit({
                "type": "status",
                "status": "error",
                "message": err_msg,
                "error": err_msg,
                "code": "INIT_FAILED",
                "timestamp": current_time_ms()
            })
            return False

    def emit_final(self, text):
        """Emits a finalized speech transcription segment."""
        if text and text.strip() and not self.is_paused and self.running:
            emit({
                "type": "final",
                "text": text.strip(),
                "timestamp": current_time_ms()
            })

    def _worker_loop(self):
        """Worker thread reading finalized sentences from recorder."""
        while self.running and not self.stop_event.is_set():
            if not self.recorder:
                break
            try:
                # recorder.text() blocks until speech segment finishes or recorder shuts down
                final_text = self.recorder.text()
                if self.stop_event.is_set() or not self.running:
                    break
                self.emit_final(final_text)
            except Exception as e:
                if self.stop_event.is_set() or not self.running:
                    break
                sys.stderr.write(f"[Sidecar] Error reading final text: {e}\n")
                time.sleep(0.05)

    def feed_pcm(self, pcm_bytes):
        """Feed raw 16-bit 16000Hz mono PCM audio bytes."""
        if len(pcm_bytes) % 2 != 0:
            emit({
                "type": "error",
                "message": "Invalid PCM chunk: byte length must be 16-bit aligned (even).",
                "code": "INVALID_PCM_ALIGNMENT",
                "timestamp": current_time_ms()
            })
            return
        if not self.recorder or not self.running or self.is_paused:
            return
        try:
            self.recorder.feed_audio(pcm_bytes, original_sample_rate=16000)
        except Exception as e:
            sys.stderr.write(f"[Sidecar] feed_audio error: {e}\n")

    def feed_silence(self, duration_seconds=1.0):
        """Feed silent PCM chunks to prompt VAD completion."""
        if not self.recorder or not self.running or self.is_paused:
            return
        duration_seconds = max(0.1, min(float(duration_seconds), 10.0))
        chunk_size = 1024
        silence = b'\x00' * int(16000 * 2 * duration_seconds)
        for i in range(0, len(silence), chunk_size * 2):
            if self.stop_event.is_set() or not self.running:
                break
            self.recorder.feed_audio(silence[i:i + chunk_size * 2], original_sample_rate=16000)
            time.sleep(0.01)

    def pause(self):
        self.is_paused = True
        emit({
            "type": "status",
            "status": "paused",
            "message": "Transcription paused.",
            "timestamp": current_time_ms()
        })

    def resume(self):
        self.is_paused = False
        emit({
            "type": "status",
            "status": "ready",
            "message": "Transcription resumed.",
            "timestamp": current_time_ms()
        })

    def shutdown(self):
        self.running = False
        self.is_paused = True
        self.stop_event.set()
        if self.recorder:
            try:
                self.recorder.shutdown()
            except Exception:
                pass
            self.recorder = None
        emit({
            "type": "status",
            "status": "stopped",
            "message": "Engine shut down cleanly.",
            "timestamp": current_time_ms()
        })

def main():
    engine = ScandiumSTTEngine()
    emit({
        "type": "status",
        "status": "alive",
        "message": "Sidecar process active.",
        "timestamp": current_time_ms()
    })

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                # EOF on stdin (parent process exited or closed pipe)
                break
            if len(line) > MAX_LINE_LENGTH:
                emit({
                    "type": "error",
                    "message": f"Protocol line exceeds maximum permitted length of {MAX_LINE_LENGTH} bytes.",
                    "code": "LINE_TOO_LONG",
                    "timestamp": current_time_ms()
                })
                continue

            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except json.JSONDecodeError as jde:
                emit({
                    "type": "error",
                    "message": f"Invalid JSON protocol input: {str(jde)}",
                    "code": "INVALID_JSON",
                    "timestamp": current_time_ms()
                })
                continue

            cmd = msg.get("type") or msg.get("command")

            if cmd == "init":
                model = msg.get("model", "tiny.en")
                root = msg.get("download_root")
                engine.initialize(model_name=model, download_root=root)

            elif cmd == "feed":
                b64 = msg.get("data") or msg.get("pcm")
                if not b64 or not isinstance(b64, str):
                    emit({
                        "type": "error",
                        "message": "Feed command requires string data payload.",
                        "code": "MISSING_DATA",
                        "timestamp": current_time_ms()
                    })
                    continue
                if len(b64) > MAX_AUDIO_CHUNK_BYTES:
                    emit({
                        "type": "error",
                        "message": f"Audio chunk exceeds maximum limit of {MAX_AUDIO_CHUNK_BYTES} characters.",
                        "code": "CHUNK_TOO_LARGE",
                        "timestamp": current_time_ms()
                    })
                    continue
                try:
                    raw_bytes = base64.b64decode(b64, validate=True)
                except Exception as b64err:
                    emit({
                        "type": "error",
                        "message": f"Invalid base64 audio payload: {str(b64err)}",
                        "code": "INVALID_BASE64",
                        "timestamp": current_time_ms()
                    })
                    continue

                engine.feed_pcm(raw_bytes)

            elif cmd == "feed_silence":
                dur = float(msg.get("duration", 1.0))
                engine.feed_silence(dur)

            elif cmd == "pause":
                engine.pause()

            elif cmd == "resume":
                engine.resume()

            elif cmd == "stop" or cmd == "shutdown":
                engine.shutdown()
                break

            elif cmd == "ping":
                emit({
                    "type": "pong",
                    "timestamp": current_time_ms()
                })

            else:
                emit({
                    "type": "error",
                    "message": f"Unknown command: {cmd}",
                    "code": "UNKNOWN_COMMAND",
                    "timestamp": current_time_ms()
                })

        except KeyboardInterrupt:
            break
        except Exception as e:
            sys.stderr.write(f"[Sidecar] Request handling error: {e}\n{traceback.format_exc()}\n")
            emit({
                "type": "error",
                "message": str(e),
                "code": "INTERNAL_ERROR",
                "timestamp": current_time_ms()
            })

    engine.shutdown()

if __name__ == "__main__":
    main()
