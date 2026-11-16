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

def emit(obj):
    """Emit JSON message over stdout."""
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    except Exception as e:
        sys.stderr.write(f"[Sidecar] Failed to emit message: {e}\n")

class ScandiumSTTEngine:
    def __init__(self):
        self.recorder = None
        self.running = False
        self.is_paused = False
        self.worker_thread = None
        self.model_name = "tiny.en"
        self.download_root = None

    def initialize(self, model_name="tiny.en", download_root=None):
        emit({"type": "status", "status": "initializing", "message": f"Loading model {model_name}..."})
        try:
            from RealtimeSTT import AudioToTextRecorder

            self.model_name = model_name
            self.download_root = download_root

            def on_interim(text):
                if text and text.strip() and not self.is_paused:
                    emit({"type": "interim", "text": text.strip(), "timestamp": time.time()})

            def on_stabilized(text):
                if text and text.strip() and not self.is_paused:
                    emit({"type": "stabilized", "text": text.strip(), "timestamp": time.time()})

            # RealtimeSTT CPU INT8 configuration optimized for 16GB Intel CPU
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

            self.running = True
            self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
            self.worker_thread.start()

            emit({
                "type": "status",
                "status": "ready",
                "model": self.model_name,
                "message": f"RealtimeSTT initialized with model {self.model_name}."
            })
            return True
        except Exception as e:
            err_msg = f"Initialization error: {str(e)}"
            sys.stderr.write(f"[Sidecar] {err_msg}\n{traceback.format_exc()}\n")
            emit({"type": "status", "status": "error", "error": err_msg})
            return False

    def _worker_loop(self):
        """Worker thread continuously reading finalized text sentences from recorder."""
        while self.running and self.recorder:
            try:
                final_text = self.recorder.text()
                if final_text and final_text.strip() and not self.is_paused:
                    emit({
                        "type": "final",
                        "text": final_text.strip(),
                        "timestamp": time.time()
                    })
            except Exception as e:
                if not self.running:
                    break
                sys.stderr.write(f"[Sidecar] Error reading final text: {e}\n")
                time.sleep(0.05)

    def feed_pcm(self, pcm_bytes):
        """Feed raw 16-bit 16000Hz mono PCM audio bytes."""
        if not self.recorder or not self.running or self.is_paused:
            return
        try:
            self.recorder.feed_audio(pcm_bytes, original_sample_rate=16000)
        except Exception as e:
            sys.stderr.write(f"[Sidecar] feed_audio error: {e}\n")

    def feed_silence(self, duration_seconds=1.0):
        """Feed silent PCM chunks to prompt VAD completion."""
        if not self.recorder or not self.running:
            return
        chunk_size = 1024
        silence = b'\x00' * int(16000 * 2 * duration_seconds)
        for i in range(0, len(silence), chunk_size * 2):
            self.recorder.feed_audio(silence[i:i + chunk_size * 2], original_sample_rate=16000)
            time.sleep(0.01)

    def pause(self):
        self.is_paused = True
        emit({"type": "status", "status": "paused", "message": "Transcription paused."})

    def resume(self):
        self.is_paused = False
        emit({"type": "status", "status": "ready", "message": "Transcription resumed."})

    def shutdown(self):
        self.running = False
        self.is_paused = True
        if self.recorder:
            try:
                self.recorder.shutdown()
            except Exception:
                pass
            self.recorder = None
        emit({"type": "status", "status": "stopped", "message": "Engine shut down cleanly."})

def main():
    engine = ScandiumSTTEngine()
    emit({"type": "status", "status": "alive", "message": "Sidecar process active."})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            cmd = msg.get("type") or msg.get("command")

            if cmd == "init":
                model = msg.get("model", "tiny.en")
                root = msg.get("download_root")
                engine.initialize(model_name=model, download_root=root)

            elif cmd == "feed":
                b64 = msg.get("data") or msg.get("pcm")
                if b64:
                    raw_bytes = base64.b64decode(b64)
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
                emit({"type": "pong", "timestamp": time.time()})

            else:
                emit({"type": "error", "error": f"Unknown command: {cmd}"})

        except json.JSONDecodeError as jde:
            emit({"type": "error", "error": f"Invalid JSON input: {str(jde)}"})
        except Exception as e:
            sys.stderr.write(f"[Sidecar] Request handling error: {e}\n{traceback.format_exc()}\n")
            emit({"type": "error", "error": str(e)})

    engine.shutdown()

if __name__ == "__main__":
    main()
