"""Portable MuseTalk crop extraction for systems without compiled MMCV ops."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


coord_placeholder = (0.0, 0.0, 0.0, 0.0)


def read_imgs(img_list):
    frames = [cv2.imread(str(path)) for path in img_list]
    if any(frame is None for frame in frames):
        raise RuntimeError("MuseTalk n’a pas pu lire une image du clip LivePortrait.")
    return frames


def get_landmark_and_bbox(img_list, upperbondrange=0):
    """Detect and temporally smooth the face crop boxes used by MuseTalk."""
    frames = read_imgs(img_list)
    cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    detector = cv2.CascadeClassifier(str(cascade_path))
    if detector.empty():
        raise RuntimeError(f"Détecteur facial OpenCV introuvable: {cascade_path}")

    boxes: list[np.ndarray | None] = []
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        height, width = gray.shape
        found = detector.detectMultiScale(
            gray,
            # The more permissive settings are needed for stylized avatars.
            # A larger minimum suppresses false positives around eyes/armor;
            # the largest remaining box is the full face, not a small patch.
            scaleFactor=1.05,
            minNeighbors=3,
            minSize=(max(80, width // 6), max(80, height // 6)),
        )
        if len(found):
            # Prefer the largest face; the clip contains one speaking avatar.
            x, y, w, h = max(found, key=lambda item: int(item[2]) * int(item[3]))
            # Slight padding retains forehead and chin for MuseTalk's face parser.
            pad_x, pad_y = round(w * 0.035), round(h * 0.035)
            boxes.append(np.array([
                max(0, x - pad_x), max(0, y - pad_y + int(upperbondrange)),
                min(width, x + w + pad_x), min(height, y + h + pad_y),
            ], dtype=np.float32))
        else:
            boxes.append(None)

    valid = [index for index, box in enumerate(boxes) if box is not None]
    if not valid:
        raise RuntimeError("MuseTalk n’a détecté aucun visage dans la base LivePortrait.")

    # Interpolate missed frames, then median-filter small detector jitters.
    matrix = np.asarray([
        box if box is not None else np.full(4, np.nan, dtype=np.float32)
        for box in boxes
    ])
    for coordinate in range(4):
        matrix[:, coordinate] = np.interp(
            np.arange(len(frames)), valid, matrix[valid, coordinate]
        )
    smoothed = matrix.copy()
    for index in range(len(frames)):
        start, stop = max(0, index - 2), min(len(frames), index + 3)
        smoothed[index] = np.median(matrix[start:stop], axis=0)

    result = []
    for box, frame in zip(smoothed, frames):
        height, width = frame.shape[:2]
        x1, y1, x2, y2 = np.rint(box).astype(int)
        x1, x2 = np.clip([x1, x2], 0, width)
        y1, y2 = np.clip([y1, y2], 0, height)
        result.append((int(x1), int(y1), int(x2), int(y2)))
    print(f"MuseTalk: {len(valid)}/{len(frames)} détections, interpolation et lissage activés.")
    return result, frames
