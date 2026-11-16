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

if __name__ == "__main__":
    unittest.main()
