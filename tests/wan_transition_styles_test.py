"""Run with the ComfyUI Python: python tests/wan_transition_styles_test.py."""
import json
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from wan_transition_effects import refine_window, transition_windows
spec = importlib.util.spec_from_file_location("refine_wan_transitions",
                                             Path(__file__).resolve().parents[1] / "scripts/refine-wan-transitions.py")
refinement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refinement)
COLOUR_FLAGS, refine_video = refinement.COLOUR_FLAGS, refinement.refine_video


def sample_frames(count=160):
    frames = {}
    for index in range(count):
        frame = np.full((64, 96, 3), 60, dtype=np.uint8)
        position = 24 if index < 60 else 36 + ((index - 60) // 3) % 8
        frame[16:44, position:position + 16] = [100, 140, 170]
        frames[index] = frame
    return frames


class TransitionStylesTest(unittest.TestCase):
    def test_two_choices_produce_distinct_reprises_without_modifying_source_images(self):
        frames = sample_frames()
        original = {index: frame.copy() for index, frame in frames.items()}
        window = transition_windows([{"frame": 60, "pauseStartFrame": 24}], 48, 160)[0]
        three = refine_window(frames, window, "interpolated")
        four = refine_window(frames, window, "reconstructed")
        self.assertGreater(np.abs(three[66].astype(float) - four[66]).sum(), 10)
        self.assertEqual(set(three), set(range(window["start"], window["end"] + 1)))
        self.assertEqual(set(four), set(three))
        np.testing.assert_array_equal(three[window["start"]], frames[window["start"]])
        for index in frames:
            np.testing.assert_array_equal(frames[index], original[index])

    def test_short_tails_and_adjacent_cuts_stay_inside_their_actual_segments(self):
        boundaries = [{"frame": 24, "pauseStartFrame": 18}, {"frame": 60, "pauseStartFrame": 51}]
        windows = transition_windows(boundaries, 48, 76)
        frames = sample_frames(76)
        for previous, following in zip(windows, windows[1:]):
            self.assertLess(previous["end"], following["start"])
        for window in windows:
            self.assertLess(window["read_end"], 76)
            for style in ["interpolated", "reconstructed"]:
                refined = refine_window(frames, window, style)
                self.assertTrue(all(0 <= index < 76 for index in refined))

    def test_no_pause_and_short_final_block_are_supported(self):
        frames = sample_frames(68)
        windows = transition_windows([{"frame": 60, "pauseStartFrame": 60}], 48, 68)
        for style in ["interpolated", "reconstructed"]:
            refined = refine_window(frames, windows[0], style)
            self.assertTrue(all(60 <= index < 68 for index in refined))

    def test_invalid_boundary_is_rejected(self):
        for boundary in [{"frame": 160, "pauseStartFrame": 150}, {"frame": 60, "pauseStartFrame": 61}]:
            with self.assertRaises(ValueError):
                transition_windows([boundary], 48, 160)

    def test_streamed_video_keeps_frame_clock_and_final_frame_for_both_choices(self):
        with tempfile.TemporaryDirectory(prefix="wan-styles-test-") as directory:
            root = Path(directory)
            frames = sample_frames()
            raw = root / "source.mkv"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", "96x64", "-r", "48", "-i", "pipe:0", "-c:v", "ffv1", str(raw)],
                           input=b"".join(frame.tobytes() for frame in frames.values()), check=True)
            for style in ["interpolated", "reconstructed"]:
                output = root / f"{style}.mp4"
                self.assertEqual(refine_video(str(raw), str(output), [{"frame": 60, "pauseStartFrame": 24}], style), 160)
                metadata = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                                           "-show_entries", "stream=avg_frame_rate,nb_read_frames,width,height", "-of", "json", str(output)],
                                          check=True, capture_output=True, text=True)
                stream = json.loads(metadata.stdout)["streams"][0]
                self.assertEqual(stream["avg_frame_rate"], "48/1")
                self.assertEqual(stream["nb_read_frames"], "160")
                self.assertEqual((stream["width"], stream["height"]), (96, 64))
                pixels = subprocess.run(["ffmpeg", "-v", "error", "-i", str(output), "-an",
                                         "-vf", f"scale=out_range=pc:flags={COLOUR_FLAGS}",
                                         "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"], check=True, capture_output=True).stdout
                decoded = np.frombuffer(pixels, dtype=np.uint8).reshape(160, 64, 96, 3)
                for index in [0, 8, 150, 159]:
                    self.assertLess(np.mean(np.abs(decoded[index].astype(float) - frames[index])), 3)


if __name__ == "__main__":
    unittest.main()
