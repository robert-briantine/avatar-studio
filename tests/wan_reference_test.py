"""Run with the ComfyUI Python; no GPU or model required."""
import importlib.util
from pathlib import Path
import unittest

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location(
    "reference", Path(__file__).resolve().parents[1] / "comfy/custom_nodes/dgx_avatar/reference.py"
)
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


def fixture():
    image = np.full((128, 192, 3), 0.12, dtype=np.float32)
    rng = np.random.default_rng(123)
    for _ in range(150):
        center = tuple(int(v) for v in rng.integers([15, 15], [177, 113]))
        color = tuple(float(v) for v in rng.uniform(0.15, 0.95, 3))
        cv2.circle(image, center, int(rng.integers(2, 7)), color, -1)
    return image


def sharpness(image):
    return cv2.Laplacian(cv2.cvtColor(image, cv2.COLOR_RGB2GRAY), cv2.CV_32F).var()


class ReferenceTest(unittest.TestCase):
    def test_identical_image_is_preserved_exactly(self):
        original = fixture()
        restored, info = reference.restore_reference(original, original)
        np.testing.assert_array_equal(restored, original)
        self.assertEqual(info["mode"], "identical")

    def test_rebuilds_detail_without_copying_blur(self):
        original = fixture()
        moved = cv2.warpAffine(original, np.float32([[1, 0, 4], [0, 1, 2]]), (192, 128), borderMode=cv2.BORDER_REPLICATE)
        previous = cv2.GaussianBlur(moved, (0, 0), 1.8)
        before = previous.copy()
        restored, info = reference.restore_reference(original, previous)
        self.assertEqual(info["mode"], "aligned_original")
        self.assertGreater(info["max_displacement"], 1)
        self.assertGreater(sharpness(restored), sharpness(previous) * 3)
        self.assertLess(np.mean(abs(restored - moved)), np.mean(abs(original - moved)))
        np.testing.assert_array_equal(previous, before)
        self.assertEqual(restored.shape, original.shape)
        self.assertTrue(np.isfinite(restored).all())
        self.assertGreaterEqual(float(restored.min()), 0)
        self.assertLessEqual(float(restored.max()), 1)

    def test_unreliable_pose_falls_back_to_original(self):
        original = fixture()
        restored, info = reference.restore_reference(original, np.full_like(original, 0.5))
        np.testing.assert_array_equal(restored, original)
        self.assertEqual(info["mode"], "original")
        unrelated = np.flip(original, axis=1).copy()
        restored, info = reference.restore_reference(original, unrelated)
        self.assertEqual(info["mode"], "original")
        np.testing.assert_array_equal(restored, original)

    def test_deformation_is_bounded_against_original(self):
        y, x = np.mgrid[:128, :192].astype(np.float32)
        flow = np.stack([100 * np.sin(x / 3), 100 * np.cos(y / 3)], axis=-1)
        limited = reference.bounded_motion(flow, np.ones((128, 192), np.float32))
        self.assertLessEqual(np.linalg.norm(limited, axis=2).max(), 128 * reference.MAX_DISPLACEMENT_RATIO + 1e-5)
        dy, dx = np.gradient(limited, axis=(0, 1))
        strain = np.sqrt(np.sum(dx * dx + dy * dy, axis=2))
        self.assertLessEqual(strain.max(), reference.MAX_DEFORMATION + 1e-5)

    def test_twenty_handoffs_do_not_accumulate_resampling_blur(self):
        original = fixture()
        previous = original.copy()
        scores = []
        for _ in range(20):
            degraded = cv2.GaussianBlur(previous, (0, 0), 1.8)
            degraded = cv2.warpAffine(degraded, np.float32([[1, 0, 1], [0, 1, 0]]), (192, 128), borderMode=cv2.BORDER_REPLICATE)
            previous, info = reference.restore_reference(original, degraded)
            scores.append(sharpness(previous))
            self.assertLessEqual(info.get("max_displacement", 0), 128 * reference.MAX_DISPLACEMENT_RATIO + 0.01)
        self.assertGreater(min(scores), sharpness(original) * 0.5)
        self.assertGreater(scores[-1], scores[0] * 0.8)

    def test_rejects_invalid_images(self):
        original = fixture()
        with self.assertRaises(ValueError):
            reference.restore_reference(original, original[:20])
        invalid = original.copy()
        invalid[0, 0, 0] = np.nan
        with self.assertRaises(ValueError):
            reference.restore_reference(original, invalid)


if __name__ == "__main__":
    unittest.main()
