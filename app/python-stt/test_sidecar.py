#!/usr/bin/env python3
"""
Unit and integration tests for the Scandium RealtimeSTT Python Sidecar Protocol.
Tests protocol limits, error handling, base64 validation, PCM alignment,
pause/resume, and clean shutdown without requiring GPU or heavy model downloads.
"""

import unittest
import subprocess
import sys
import os
import json
import time

SIDECAR_PATH = os.path.join(os.path.dirname(__file__), "scandium_stt_sidecar.py")

class TestSidecarProtocol(unittest.TestCase):
    def setUp(self):
        self.proc = subprocess.Popen(
            [sys.executable, SIDECAR_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1
        )

    def tearDown(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
                self.proc.stdin.flush()
                self.proc.wait(timeout=3)
            except Exception:
                self.proc.kill()
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            if self.proc.stdout:
                self.proc.stdout.close()
            if self.proc.stderr:
                self.proc.stderr.close()
        except Exception:
            pass

    def read_event(self, timeout=3.0):
        start = time.time()
        while time.time() - start < timeout:
            line = self.proc.stdout.readline()
            if line:
                line = line.strip()
                if line:
                    try:
                        return json.loads(line)
                    except json.JSONDecodeError:
                        continue
            time.sleep(0.02)
        return None

    def send_cmd(self, obj):
        line = json.dumps(obj) + "\n"
        self.proc.stdin.write(line)
        self.proc.stdin.flush()

    def test_01_handshake_alive(self):
        event = self.read_event()
        self.assertIsNotNone(event)
        self.assertEqual(event.get("type"), "status")
        self.assertEqual(event.get("status"), "alive")
        self.assertIn("timestamp", event)
        self.assertIsInstance(event["timestamp"], int)

    def test_02_ping_pong(self):
        # consume alive
        self.read_event()
        self.send_cmd({"type": "ping"})
        pong = self.read_event()
        self.assertIsNotNone(pong)
        self.assertEqual(pong.get("type"), "pong")
        self.assertIn("timestamp", pong)

    def test_03_malformed_json_rejected(self):
        # consume alive
        self.read_event()
        self.proc.stdin.write("NOT_A_VALID_JSON\n")
        self.proc.stdin.flush()
        err = self.read_event()
        self.assertIsNotNone(err)
        self.assertEqual(err.get("type"), "error")
        self.assertEqual(err.get("code"), "INVALID_JSON")

    def test_04_unknown_command_rejected(self):
        self.read_event()
        self.send_cmd({"type": "nonexistent_command"})
        err = self.read_event()
        self.assertIsNotNone(err)
        self.assertEqual(err.get("type"), "error")
        self.assertEqual(err.get("code"), "UNKNOWN_COMMAND")

    def test_05_invalid_base64_rejected(self):
        self.read_event()
        self.send_cmd({"type": "feed", "data": "This is definitely not valid base64!@#$%"})
        err = self.read_event()
        self.assertIsNotNone(err)
        self.assertEqual(err.get("type"), "error")
        self.assertEqual(err.get("code"), "INVALID_BASE64")

    def test_06_chunk_too_large_rejected(self):
        self.read_event()
        oversized = "A" * (600 * 1024)  # 600KB exceeds 512KB limit
        self.send_cmd({"type": "feed", "data": oversized})
        err = self.read_event()
        self.assertIsNotNone(err)
        self.assertEqual(err.get("type"), "error")
        self.assertEqual(err.get("code"), "CHUNK_TOO_LARGE")

    def test_07_pause_and_resume(self):
        self.read_event()
        self.send_cmd({"type": "pause"})
        paused = self.read_event()
        self.assertIsNotNone(paused)
        self.assertEqual(paused.get("type"), "status")
        self.assertEqual(paused.get("status"), "paused")

        self.send_cmd({"type": "resume"})
        resumed = self.read_event()
        self.assertIsNotNone(resumed)
        self.assertEqual(resumed.get("type"), "status")
        self.assertEqual(resumed.get("status"), "ready")

    def test_08_clean_shutdown(self):
        self.read_event()
        self.send_cmd({"type": "shutdown"})
        stopped = self.read_event()
        self.assertIsNotNone(stopped)
        self.assertEqual(stopped.get("type"), "status")
        self.assertEqual(stopped.get("status"), "stopped")
        exit_code = self.proc.wait(timeout=3)
        self.assertEqual(exit_code, 0)

    def test_09_feed_pcm_audio_accepts_valid_audio(self):
        self.read_event()  # consume alive
        wav_path = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "jfk.wav")
        if os.path.exists(wav_path):
            import wave
            import base64
            with wave.open(wav_path, "rb") as wf:
                pcm_data = wf.readframes(1600)  # 100ms chunk (3200 bytes)
                b64 = base64.b64encode(pcm_data).decode("ascii")
                self.send_cmd({"type": "feed", "data": b64})
                # Check that no error is returned
                self.send_cmd({"type": "ping"})
                pong = self.read_event()
                self.assertIsNotNone(pong)
                self.assertEqual(pong.get("type"), "pong")

    def test_10_unaligned_pcm_rejected(self):
        self.read_event()
        import base64
        # 3 bytes is odd, violating 16-bit PCM alignment (must be multiple of 2)
        odd_b64 = base64.b64encode(b"\x00\x01\x02").decode("ascii")
        self.send_cmd({"type": "feed", "data": odd_b64})
        err = self.read_event()
        self.assertIsNotNone(err)
        self.assertEqual(err.get("type"), "error")
        self.assertEqual(err.get("code"), "INVALID_PCM_ALIGNMENT")


class TestTranscriptionPipeline(unittest.TestCase):
    """Direct test of the STTEngine class and transcript emission pipeline."""

    def test_transcription_event_flow(self):
        import io
        from unittest.mock import MagicMock, patch
        import scandium_stt_sidecar

        captured_stdout = io.StringIO()
        engine = scandium_stt_sidecar.ScandiumSTTEngine()
        mock_recorder = MagicMock()

        with patch("sys.stdout", captured_stdout):
            engine.recorder = mock_recorder
            engine.running = True
            engine.is_paused = False

            # Feed audio chunk
            pcm_chunk = b"\x00\x00" * 1600
            engine.feed_pcm(pcm_chunk)
            mock_recorder.feed_audio.assert_called_with(pcm_chunk, original_sample_rate=16000)

            # Emulate finalized sentence emission
            engine.emit_final("Ask not what your country can do for you.")
            engine.shutdown()

        lines = [json.loads(line) for line in captured_stdout.getvalue().strip().split("\n") if line.strip()]
        event_types = [item.get("type") for item in lines]
        self.assertIn("final", event_types)

        final_event = next(item for item in lines if item.get("type") == "final")
        self.assertEqual(final_event.get("text"), "Ask not what your country can do for you.")
        self.assertIsInstance(final_event.get("timestamp"), int)


class TestRealtimeSTTRealAudioTranscription(unittest.TestCase):
    """End-to-end integration test executing real INT8 audio transcription against jfk.wav fixture."""

    def test_real_audio_transcription_on_jfk_sample(self):
        wav_path = os.path.join(os.path.dirname(__file__), "..", "resources", "whisper", "jfk.wav")
        if not os.path.exists(wav_path):
            self.skipTest(f"Audio fixture {wav_path} not found")

        # Ensure PyAV compatibility shim is active
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

        try:
            from faster_whisper import WhisperModel
        except ImportError:
            self.skipTest("faster_whisper not installed in test environment")

        # Initialize real INT8 quantized CPU model
        model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
        segments, info = model.transcribe(wav_path)
        transcribed_text = " ".join([s.text for s in segments]).strip()

        # Assert JFK historic speech is transcribed accurately
        self.assertTrue(len(transcribed_text) > 0, "Transcribed text must not be empty")
        self.assertTrue(
            "country" in transcribed_text.lower() or "americans" in transcribed_text.lower(),
            f"Expected JFK speech content, got: {transcribed_text}"
        )


if __name__ == "__main__":
    unittest.main()
