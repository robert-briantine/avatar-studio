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

    def test_handoff_rebuilds_detail_and_restores_appearance(self):
        original = fixture()
        moved = cv2.warpAffine(original, np.float32([[1, 0, 3], [0, 1, 2]]),
                               (192, 128), borderMode=cv2.BORDER_REPLICATE)
        previous = cv2.GaussianBlur(moved, (0, 0), 1.4)
        prepared, info = reference.prepare_handoff(original, previous)
        self.assertEqual(info["mode"], "restored_motion_anchor")
        self.assertEqual(info["alignment"], "aligned_original")
        self.assertEqual(info["original_weight"], reference.HANDOFF_RESTORE_BLEND)
        self.assertEqual(prepared.shape, previous.shape)
        self.assertGreater(sharpness(prepared), sharpness(previous))
        restored, _ = reference.restore_reference(original, previous)
        expected = previous * (1 - reference.HANDOFF_RESTORE_BLEND) + restored * reference.HANDOFF_RESTORE_BLEND
        np.testing.assert_allclose(prepared, expected, atol=1e-7)

    def test_handoff_fallback_never_replaces_generated_pose_with_original(self):
        original = fixture()
        previous = np.flip(original, axis=1).copy()
        prepared, info = reference.prepare_handoff(original, previous)
        self.assertEqual(info["alignment"], "original")
        self.assertLess(np.mean(np.abs(prepared - previous)), 0.01)
        self.assertGreater(np.mean(np.abs(prepared - original)), 0.02)

    def test_control_sequence_holds_only_the_clean_anchor_during_overlap(self):
        original = fixture()
        moved = cv2.warpAffine(original, np.float32([[1, 0, 3], [0, 1, 2]]),
                               (192, 128), borderMode=cv2.BORDER_REPLICATE)
        previous = cv2.GaussianBlur(moved, (0, 0), 1.4)
        control, prepared, info = reference.build_handoff_sequence(original, previous)
        self.assertEqual(control.shape, (reference.HANDOFF_CONTROL_FRAMES, *previous.shape))
        for frame in control:
            np.testing.assert_array_equal(frame, prepared)
        self.assertEqual(info["control_frames"], 9)
        self.assertEqual(info["control_mode"], "clean_hold")
        self.assertGreater(float(np.mean(np.abs(control[0] - previous))), 0)

    def test_local_red_lips_are_removed_by_original_pixels(self):
        original = fixture()
        previous = original.copy()
        previous[54:76, 77:116] = [0.95, 0.08, 0.12]
        previous = cv2.GaussianBlur(previous, (0, 0), 0.8)
        prepared, info = reference.prepare_handoff(original, previous)
        self.assertEqual(info["alignment"], "aligned_original")
        before_red = np.mean(previous[54:76, 77:116, 0] - previous[54:76, 77:116, 1])
        after_red = np.mean(prepared[54:76, 77:116, 0] - prepared[54:76, 77:116, 1])
        self.assertLess(after_red, before_red * 0.45)
        self.assertGreater(sharpness(prepared), sharpness(previous))

    def test_repeated_handoff_processing_stays_bounded(self):
        original = fixture()
        previous = original.copy()
        original_mean = original.mean(axis=(0, 1))
        scores = []
        for _ in range(20):
            degraded = cv2.GaussianBlur(previous, (0, 0), 0.8)
            previous, info = reference.prepare_handoff(original, degraded)
            scores.append(sharpness(previous))
            self.assertEqual(previous.shape, original.shape)
            self.assertTrue(np.isfinite(previous).all())
        np.testing.assert_allclose(previous.mean(axis=(0, 1)), original_mean, atol=2e-3)
        self.assertGreater(min(scores), 0)
        self.assertLess(max(scores), sharpness(original) * 2.5)

    def test_repeated_photometric_drift_is_not_fed_back_forever(self):
        original = fixture()
        previous = original.copy()
        uncorrected = original.copy()
        gray_weights = np.array([0.299, 0.587, 0.114], dtype=np.float32)
        for _ in range(16):
            # Approximate the failure observed on a long Wan render: every
            # native block raises exposure/contrast and removes some colour.
            for image_name in ("previous", "uncorrected"):
                image = previous if image_name == "previous" else uncorrected
                gray = np.sum(image * gray_weights, axis=2, keepdims=True)
                image = gray + (image - gray) * 0.94
                image = np.clip((image - image.mean(axis=(0, 1), keepdims=True)) * 1.025
                                + image.mean(axis=(0, 1), keepdims=True) + 0.012, 0, 1)
                if image_name == "previous":
                    previous, _ = reference.prepare_handoff(original, image)
                else:
                    uncorrected = image
        corrected_error = np.mean(np.abs(previous.mean(axis=(0, 1)) - original.mean(axis=(0, 1))))
        uncorrected_error = np.mean(np.abs(uncorrected.mean(axis=(0, 1)) - original.mean(axis=(0, 1))))
        self.assertLess(corrected_error, 0.02)
        self.assertLess(corrected_error, uncorrected_error * 0.25)
        self.assertTrue(np.isfinite(previous).all())
        self.assertGreaterEqual(float(previous.min()), 0)
        self.assertLessEqual(float(previous.max()), 1)


if __name__ == "__main__":
    unittest.main()
