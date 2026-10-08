"""Run with the ComfyUI Python: python tests/wan_lighting_test.py."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location(
    "lighting", Path(__file__).resolve().parents[1] / "scripts" / "match-wan-lighting.py"
)
lighting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lighting)


class LightingTest(unittest.TestCase):
    def test_matching_reference_does_not_change_pixels(self):
        frame = np.random.default_rng(123).integers(0, 256, (64, 64, 3), dtype=np.uint8)
        np.testing.assert_array_equal(lighting.match_frame_lighting(frame, lighting.lighting_profile(frame)), frame)

    def test_shadow_reconstruction_recovers_tones_without_adding_saturated_red(self):
        levels = np.tile(np.linspace(8, 210, 128), (64, 1))
        reference = np.stack([levels, levels + 4, levels + 8], axis=-1).astype(np.uint8)
        frame = np.clip(reference.astype(float) * 1.2 - 16, 0, 255).astype(np.uint8)
        repaired = lighting.match_frame_lighting(frame, lighting.lighting_profile(reference))
        self.assertLess(np.mean(np.abs(repaired.astype(float) - reference)),
                        np.mean(np.abs(frame.astype(float) - reference)) * 0.25)
        self.assertLessEqual(np.max(np.abs(repaired.astype(float) - frame)), lighting.MAX_LIGHTING_SHIFT)
        # A shared RGB shift cannot invent a larger red excess or colour blob.
        excess = lambda image: image[:, :, 2].astype(float) - np.maximum(image[:, :, 0], image[:, :, 1])
        self.assertTrue(np.all(excess(repaired) <= excess(frame) + 1))

    def test_flat_dark_frames_are_finite_and_correction_is_bounded(self):
        frame = np.zeros((64, 64, 3), dtype=np.uint8)
        reference = np.full_like(frame, 200)
        repaired = lighting.match_frame_lighting(frame, lighting.lighting_profile(reference))
        self.assertEqual(repaired.dtype, np.uint8)
        self.assertEqual(int(repaired.max()), lighting.MAX_LIGHTING_SHIFT)

    def test_handoff_correction_ends_after_half_a_second(self):
        self.assertEqual(lighting.handoff_strength(0.25, 0.5), 1)
        self.assertEqual(lighting.handoff_strength(0.375, 0.5), 0.5)
        self.assertEqual(lighting.handoff_strength(0.5, 0.5), 0)
        self.assertEqual(lighting.handoff_strength(4, 0.5), 0)

    def test_real_video_keeps_frame_clock_and_leaves_later_lighting_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="wan-lighting-test-") as directory:
            root = Path(directory)
            raw, output, start = root / "raw.mkv", root / "out.mp4", root / "start.png"
            reference = np.full((64, 64, 3), 100, dtype=np.uint8)
            cv2.imwrite(str(start), reference)
            frames = [np.full_like(reference, 80 if index < 8 else 150) for index in range(16)]
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                "-s", "64x64", "-r", "16", "-i", "pipe:0", "-c:v", "ffv1", str(raw),
            ], input=b"".join(frame.tobytes() for frame in frames), check=True)
            self.assertEqual(lighting.match_video(str(raw), str(output), str(start)), 16)
            decoded = cv2.VideoCapture(str(output))
            self.assertEqual(decoded.get(cv2.CAP_PROP_FPS), 16)
            decoded.release()
            decoded = subprocess.run([
                "ffmpeg", "-v", "error", "-i", str(output), "-an", "-f", "rawvideo",
                "-vf", f"scale=out_range=pc:flags={lighting.COLOUR_FLAGS}",
                "-pix_fmt", "bgr24", "pipe:1",
            ], check=True, capture_output=True).stdout
            means = np.frombuffer(decoded, dtype=np.uint8).reshape(16, 64, 64, 3).mean(axis=(1, 2, 3))
            self.assertEqual(len(means), 16)
            self.assertAlmostEqual(means[0], 100, delta=3)
            self.assertAlmostEqual(means[2], 100, delta=3)
            np.testing.assert_allclose(means[8:], 150, atol=1)


if __name__ == "__main__":
    unittest.main()
