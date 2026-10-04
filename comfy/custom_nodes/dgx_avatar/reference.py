"""Rebuild a Wan pose reference from original pixels, never generated textures."""
import cv2
import numpy as np


# Bounds are relative to the ORIGINAL at every handoff, not the preceding frame.
MAX_DISPLACEMENT_RATIO = 0.08
MAX_DEFORMATION = 0.25
HANDOFF_APPEARANCE_GAIN = 0.65
HANDOFF_MAX_CHANNEL_SHIFT = 0.035
# A reset anchor must not feed generated texture back into the next window.
# The preceding frame still supplies its pose through optical flow, while every
# output pixel comes from the untouched avatar reference.
HANDOFF_RESTORE_BLEND = 1.0
HANDOFF_CONTROL_FRAMES = 9


def bounded_motion(flow, confidence):
    """Keep broad pose movement; suppress uncertain and highly local distortions."""
    height, width = confidence.shape
    sigma = max(2.0, min(height, width) * 0.035)
    weight = cv2.GaussianBlur(confidence, (0, 0), sigma)
    smoothed = cv2.GaussianBlur(flow * confidence[..., None], (0, 0), sigma)
    smoothed /= np.maximum(weight[..., None], 1e-5)
    smoothed *= np.clip(weight[..., None] / 0.6, 0, 1) * 0.85
    # Limit both displacement and spatial strain, so an erroneous flow cannot
    # keep stretching a jaw/nose or fold the original image onto itself.
    magnitude = np.linalg.norm(smoothed, axis=2)
    limit = min(height, width) * MAX_DISPLACEMENT_RATIO
    smoothed *= np.minimum(1, limit / np.maximum(magnitude, 1e-5))[..., None]
    dy, dx = np.gradient(smoothed, axis=(0, 1))
    strain = np.sqrt(np.sum(dx * dx + dy * dy, axis=2)).max()
    if strain > MAX_DEFORMATION:
        smoothed *= MAX_DEFORMATION / strain
    return smoothed.astype(np.float32)


def restore_reference(original, previous):
    """Return a sharp, bounded approximation of previous's pose and diagnostics.

    RGB float arrays in [0, 1], already framed exactly as Wan's ref_image.
    Only the original supplies output pixels. Previous supplies an estimated
    displacement field; its blur, color shifts and invented details are discarded.
    This is conservative 2D registration, not a reconstruction of unseen views.
    """
    if (original.shape != previous.shape or original.ndim != 3 or original.shape[2] != 3
            or min(original.shape[:2]) < 16):
        raise ValueError("Les références doivent être deux images RGB de même taille (au moins 16 pixels).")
    if not np.isfinite(original).all() or not np.isfinite(previous).all():
        raise ValueError("Une image de référence contient des valeurs non finies.")
    original = np.clip(original, 0, 1).astype(np.float32)
    previous = np.clip(previous, 0, 1).astype(np.float32)
    if np.array_equal(original, previous):
        return original.copy(), {"mode": "identical", "confidence": 1.0}
    height, width = original.shape[:2]
    scale = min(1.0, 640 / max(height, width))
    size = (max(16, round(width * scale)), max(16, round(height * scale)))

    def gray(image):
        small = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
        luminance = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
        return np.round(cv2.GaussianBlur(luminance, (0, 0), 1.0) * 255).astype(np.uint8)

    source, target = gray(original), gray(previous)
    if min(float(source.std()), float(target.std())) < 2:
        return original.copy(), {"mode": "original", "confidence": 0.0}
    # Backward flow maps a pixel in the desired pose to the source original.
    backward = cv2.calcOpticalFlowFarneback(target, source, None, 0.5, 5, 25, 5, 7, 1.5, 0)
    forward = cv2.calcOpticalFlowFarneback(source, target, None, 0.5, 5, 25, 5, 7, 1.5, 0)
    grid = np.stack(np.meshgrid(np.arange(size[0]), np.arange(size[1])), axis=-1).astype(np.float32)
    coords = grid + backward
    valid = ((coords[..., 0] >= 0) & (coords[..., 0] <= size[0] - 1)
             & (coords[..., 1] >= 0) & (coords[..., 1] <= size[1] - 1))
    reverse = cv2.remap(forward, coords, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    cycle_error = np.linalg.norm(backward + reverse, axis=2)
    aligned = cv2.remap(source, coords, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    difference = np.abs(target.astype(np.float32) - aligned.astype(np.float32))
    confidence = (np.exp(-np.square(cycle_error / 1.5))
                  * np.exp(-np.square(difference / 25)) * valid).astype(np.float32)
    correlation = float(np.corrcoef(target.ravel(), aligned.ravel())[0, 1])
    score = float(confidence.mean())
    if not np.isfinite(correlation) or correlation < 0.55 or score < 0.25:
        return original.copy(), {"mode": "original", "confidence": round(score, 3)}

    flow = bounded_motion(backward, confidence)
    flow = cv2.resize(flow, (width, height), interpolation=cv2.INTER_LINEAR)
    flow[..., 0] *= width / size[0]
    flow[..., 1] *= height / size[1]
    grid = np.stack(np.meshgrid(np.arange(width), np.arange(height)), axis=-1).astype(np.float32)
    # Edge clamping avoids black borders or reflected duplicate features. Sample
    # the ORIGINAL once using Lanczos: no recursive image blending or sharpening.
    coords = grid + flow
    coords[..., 0] = np.clip(coords[..., 0], 0, width - 1)
    coords[..., 1] = np.clip(coords[..., 1], 0, height - 1)
    restored = cv2.remap(original, coords, None, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)
    return np.clip(restored, 0, 1), {
        "mode": "aligned_original", "confidence": round(score, 3),
        "max_displacement": round(float(np.linalg.norm(flow, axis=2).max()), 2),
    }


def prepare_handoff(original, previous):
    """Build a clean motion anchor from original pixels aligned to the last pose.

    A successful alignment supplies the entire clean anchor. The generated
    frame contributes geometry through registration, but never output pixels.
    This breaks the recursive feedback of invented lip colour and softened
    texture. If registration is unreliable, geometry is left untouched and
    only a bounded per-channel exposure correction is applied.
    """
    if (original.shape != previous.shape or original.ndim != 3 or original.shape[2] != 3
            or min(original.shape[:2]) < 16):
        raise ValueError("Les références doivent être deux images RGB de même taille (au moins 16 pixels).")
    if not np.isfinite(original).all() or not np.isfinite(previous).all():
        raise ValueError("Une image de référence contient des valeurs non finies.")
    original = np.clip(original, 0, 1).astype(np.float32)
    previous = np.clip(previous, 0, 1).astype(np.float32)
    restored, alignment = restore_reference(original, previous)
    if alignment["mode"] in ("identical", "aligned_original"):
        restored_weight = HANDOFF_RESTORE_BLEND
        prepared = previous * (1 - restored_weight) + restored * restored_weight
    else:
        # Never blend an unregistered original into a different pose. A global
        # channel shift has no geometry and cannot create a double face.
        current_mean = previous.mean(axis=(0, 1), keepdims=True)
        original_mean = original.mean(axis=(0, 1), keepdims=True)
        channel_shift = HANDOFF_APPEARANCE_GAIN * (original_mean - current_mean)
        channel_shift = np.clip(
            channel_shift, -HANDOFF_MAX_CHANNEL_SHIFT, HANDOFF_MAX_CHANNEL_SHIFT
        )
        prepared = previous + channel_shift
        restored_weight = 0.0

    prepared = np.clip(prepared, 0, 1).astype(np.float32)
    before = float(cv2.Laplacian(cv2.cvtColor(previous, cv2.COLOR_RGB2GRAY), cv2.CV_32F).var())
    after = float(cv2.Laplacian(cv2.cvtColor(prepared, cv2.COLOR_RGB2GRAY), cv2.CV_32F).var())
    return prepared, {
        "mode": "restored_motion_anchor",
        "alignment": alignment["mode"],
        "confidence": alignment.get("confidence", 0.0),
        "original_weight": restored_weight,
        "sharpness_before": round(before, 6),
        "sharpness_after": round(after, 6),
        "brightness_before": round(float(previous.mean()), 6),
        "brightness_after": round(float(prepared.mean()), 6),
        "mean_correction": round(float(np.mean(np.abs(prepared - previous))), 6),
    }


def build_handoff_sequence(original, previous):
    """Return a clean 9-frame reset control and its clean motion anchor.

    The last generated image supplies only the pose used to rebuild ``prepared``
    from original pixels. Holding that cleaned base for the complete assembly
    overlap prevents Wan from seeing the raw generated texture at reset time.
    The preceding window remains visible during the overlap and is motion-warped
    by the final assembler, so continuity does not depend on dirty control input.
    """
    prepared, diagnostics = prepare_handoff(original, previous)
    sequence = np.repeat(prepared[None, ...], HANDOFF_CONTROL_FRAMES, axis=0)
    diagnostics = {
        **diagnostics,
        "control_frames": HANDOFF_CONTROL_FRAMES,
        "control_mode": "clean_hold",
    }
    return sequence, prepared, diagnostics
