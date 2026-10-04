"""Run with the ComfyUI Python: python tests/wan_transitions_test.py."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location(
    "transitions", Path(__file__).resolve().parents[1] / "scripts" / "blend-wan-transitions.py"
)
transitions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transitions)


class TransitionsTest(unittest.TestCase):
    def test_endpoints_preserve_unmodified_frames(self):
        a = np.full((64, 64, 3), 20, dtype=np.uint8)
        b = np.full((64, 64, 3), 230, dtype=np.uint8)
        np.testing.assert_array_equal(transitions.blend_frames(a, b, 0), a)
        np.testing.assert_array_equal(transitions.blend_frames(a, b, 1), b)
        middle = transitions.blend_frames(a, b, 0.5)
        self.assertEqual(middle.dtype, np.uint8)
        self.assertTrue(np.all(np.abs(middle.astype(float) - 125) <= 1))

    def test_identical_frames_stay_sharp(self):
        a = np.random.default_rng(123).integers(0, 256, (64, 64, 3), dtype=np.uint8)
        np.testing.assert_allclose(transitions.blend_frames(a, a, 0.5), a, atol=2)

    def test_unexpected_solid_red_is_repaired_but_source_red_is_preserved(self):
        reference = np.full((80, 120, 3), [72, 66, 62], dtype=np.uint8)
        reference[8:24, 8:24] = [220, 22, 18]
        frame = reference.copy()
        frame[42:62, 55:88] = [250, 8, 12]
        protected = transitions.prepare_colour_guard(reference)
        repaired, pixels = transitions.repair_unexpected_red(frame, reference, protected)
        self.assertGreater(pixels, 400)
        np.testing.assert_array_equal(repaired[10:20, 10:20], frame[10:20, 10:20])
        before = frame[47:57, 62:80].astype(float)
        after = repaired[47:57, 62:80].astype(float)
        self.assertLess(np.mean(after[:, :, 0] - np.maximum(after[:, :, 1], after[:, :, 2])), 8)
        expected = reference[47:57, 62:80].astype(float)
        self.assertLess(np.mean(np.abs(after - expected)), np.mean(np.abs(before - expected)) * 0.1)

    def test_unexpected_red_uses_last_clean_texture_instead_of_a_gray_patch(self):
        reference = np.full((80, 120, 3), [72, 66, 62], dtype=np.uint8)
        clean = reference.copy()
        clean[42:62, 55:88] = [94, 58, 45]
        frame = clean.copy()
        frame[42:62, 55:88] = [250, 8, 12]
        repaired, pixels = transitions.repair_unexpected_red(
            frame, reference, transitions.prepare_colour_guard(reference), clean
        )
        self.assertGreater(pixels, 400)
        np.testing.assert_allclose(repaired[47:57, 62:80], clean[47:57, 62:80], atol=1)

    def test_natural_skin_and_small_red_detail_are_untouched(self):
        reference = np.full((64, 64, 3), [105, 76, 68], dtype=np.uint8)
        frame = reference.copy()
        frame[20:35, 18:46] = [170, 92, 88]
        frame[4:6, 4:6] = [255, 0, 0]
        repaired, pixels = transitions.repair_unexpected_red(
            frame, reference, transitions.prepare_colour_guard(reference)
        )
        self.assertEqual(pixels, 0)
        np.testing.assert_array_equal(repaired, frame)

    def test_rejects_audio_timeline_drift(self):
        with self.assertRaises(ValueError):
            transitions.validate_windows([{"startFrame": 0, "frames": 24}, {"startFrame": 24, "frames": 24}], 3, 16)
        with self.assertRaises(ValueError):
            transitions.validate_windows([{"startFrame": 0, "frames": 24}, {"startFrame": 16, "frames": 16}], 3, 16)

    def test_single_native_window_is_valid_for_colour_guard(self):
        self.assertEqual(transitions.validate_windows([{"startFrame": 0, "frames": 64}], 4, 16), 64)

    def test_real_ffmpeg_assembly_preserves_frames_and_master_audio(self):
        with tempfile.TemporaryDirectory(prefix="wan-transitions-test-") as directory:
            root = Path(directory)
            raw, audio, output = root / "raw.mkv", root / "audio.wav", root / "final.mp4"
            # Global frames 16..23 occur twice in the intermediate video.
            frames = [np.full((64, 64, 3), i * 2, dtype=np.uint8) for i in list(range(24)) + list(range(16, 32))]
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-s", "64x64", "-r", "16", "-i", "pipe:0", "-c:v", "ffv1", str(raw),
            ], input=b"".join(frame.tobytes() for frame in frames), check=True)
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                "sine=frequency=440:sample_rate=16000:duration=2", str(audio),
            ], check=True)
            windows = [{"startFrame": 0, "frames": 24}, {"startFrame": 16, "frames": 16}]
            self.assertEqual(transitions.assemble(str(raw), str(audio), str(output), windows, 2, 16), 32)
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration,nb_frames",
                "-of", "json", str(output),
            ], check=True, capture_output=True, text=True)
            streams = json.loads(probe.stdout)["streams"]
            self.assertEqual({s["codec_type"] for s in streams}, {"video", "audio"})
            self.assertTrue(all(abs(float(s["duration"]) - 2) < 0.02 for s in streams))
            self.assertEqual(next(s for s in streams if s["codec_type"] == "video")["nb_frames"], "32")
            decoded = subprocess.run([
                "ffmpeg", "-v", "error", "-i", str(output), "-map", "0:v:0", "-f", "rawvideo",
                "-pix_fmt", "rgb24", "pipe:1",
            ], check=True, capture_output=True).stdout
            brightness = np.frombuffer(decoded, dtype=np.uint8).reshape(32, 64, 64, 3).mean(axis=(1, 2, 3))
            # Extend exposure drift is compensated while keeping the clip's
            # early-frame exposure as its reference.
            self.assertLess(float(np.percentile(brightness, 95) - np.percentile(brightness, 5)), 42)
            padded = root / "padded-final.mp4"
            # A native 77-frame chunk can contain padding past the audio end.
            # The requested window must be assembled and the tail discarded.
            self.assertEqual(transitions.assemble(
                str(raw), str(audio), str(padded), [{"startFrame": 0, "frames": 32}], 2, 16
            ), 32)
            sound = subprocess.run([
                "ffmpeg", "-v", "error", "-i", str(output), "-map", "0:a:0", "-ar", "16000",
                "-ac", "1", "-f", "f32le", "pipe:1",
            ], check=True, capture_output=True).stdout
            samples = np.frombuffer(sound, dtype=np.float32)[:32000]
            reference = np.sin(2 * np.pi * 440 * np.arange(len(samples)) / 16000)
            self.assertGreater(np.corrcoef(samples, reference)[0, 1], 0.99)


if __name__ == "__main__":
    unittest.main()
