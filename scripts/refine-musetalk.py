#!/usr/bin/env python3
"""Keep MuseTalk's generated pixels local to the mouth before final upscale."""

from __future__ import annotations

import argparse
import subprocess
from fractions import Fraction
from pathlib import Path

import cv2
import numpy as np


def probe(path: Path) -> tuple[int, int, Fraction]:
    result = subprocess.check_output(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate",
            "-of", "default=noprint_wrappers=1", str(path),
        ],
        text=True,
    )
    values = dict(line.split("=", 1) for line in result.splitlines() if "=" in line)
    return int(values["width"]), int(values["height"]), Fraction(values["avg_frame_rate"])


def detect_motion_frames(path: Path) -> tuple[list[np.ndarray], list[tuple[float, float, float, float]]]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError(f"Impossible de lire la base LivePortrait: {path}")

    detector_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    detector = cv2.CascadeClassifier(str(detector_path))
    if detector.empty():
        raise RuntimeError(f"Détecteur facial OpenCV introuvable: {detector_path}")

    frames: list[np.ndarray] = []
    boxes: list[np.ndarray | None] = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        height, width = gray.shape
        found = detector.detectMultiScale(
            gray,
            scaleFactor=1.05,
            minNeighbors=3,
            minSize=(max(80, width // 6), max(80, height // 6)),
        )
        if len(found):
            x, y, box_width, box_height = max(found, key=lambda item: int(item[2]) * int(item[3]))
            boxes.append(np.array([x, y, x + box_width, y + box_height], dtype=np.float32))
        else:
            boxes.append(None)
    capture.release()

    valid = [index for index, box in enumerate(boxes) if box is not None]
    if not frames or not valid:
        raise RuntimeError("Impossible de détecter le visage dans la base LivePortrait.")

    matrix = np.asarray([
        box if box is not None else np.full(4, np.nan, dtype=np.float32)
        for box in boxes
    ])
    for coordinate in range(4):
        matrix[:, coordinate] = np.interp(np.arange(len(frames)), valid, matrix[valid, coordinate])
    smoothed = matrix.copy()
    for index in range(len(frames)):
        smoothed[index] = np.median(matrix[max(0, index - 2):min(len(frames), index + 3)], axis=0)
    return frames, [tuple(map(float, box)) for box in smoothed]


def mouth_mask(height: int, width: int, box: tuple[float, float, float, float]) -> np.ndarray:
    """Soft oval covering lips and a little jaw, not the nose or cheeks."""
    x1, y1, x2, y2 = box
    face_width, face_height = max(1.0, x2 - x1), max(1.0, y2 - y1)
    center = (round((x1 + x2) * 0.5), round(y1 + face_height * 0.745))
    axes = (max(2, round(face_width * 0.18)), max(2, round(face_height * 0.06)))
    binary = np.zeros((height, width), dtype=np.uint8)
    cv2.ellipse(binary, center, axes, 0, 0, 360, 255, -1, lineType=cv2.LINE_AA)
    sigma = max(1.0, min(axes) * 0.12)
    alpha = cv2.GaussianBlur(binary, (0, 0), sigmaX=sigma, sigmaY=sigma)
    return alpha.astype(np.float32)[:, :, None] / 255.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--motion", required=True)
    parser.add_argument("--generated", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--crf", type=int, default=15)
    parser.add_argument("--sharpen", type=float, default=0.45)
    parser.add_argument("--generated-opacity", type=float, default=0.82)
    args = parser.parse_args()

    motion_path = Path(args.motion)
    generated_path = Path(args.generated)
    output_path = Path(args.output)
    motion_width, motion_height, _ = probe(motion_path)
    width, height, fps = probe(generated_path)
    motion_frames, boxes = detect_motion_frames(motion_path)
    source = cv2.VideoCapture(str(generated_path))
    if not source.isOpened():
        raise RuntimeError(f"Impossible de lire la sortie MuseTalk: {generated_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.stem}.tmp.mp4")
    encoder = subprocess.Popen(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-video_size", f"{width}x{height}",
            "-framerate", str(float(fps)), "-i", "pipe:0", "-an",
            "-c:v", "libx264", "-preset", "fast", "-crf", str(args.crf),
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(temporary),
        ],
        stdin=subprocess.PIPE,
    )
    processed = 0
    try:
        assert encoder.stdin is not None
        while True:
            ok, generated = source.read()
            if not ok:
                break
            cycle_index = processed % (2 * len(motion_frames))
            # MuseTalk itself runs through the clip and then reverses it to
            # avoid a visible loop seam; mirror that sequence for compositing.
            motion_index = (
                cycle_index
                if cycle_index < len(motion_frames)
                else 2 * len(motion_frames) - 1 - cycle_index
            )
            base = motion_frames[motion_index]
            if base.shape[1] != width or base.shape[0] != height:
                base = cv2.resize(base, (width, height), interpolation=cv2.INTER_CUBIC)
            x_scale, y_scale = width / motion_width, height / motion_height
            x1, y1, x2, y2 = boxes[motion_index]
            scaled_box = (x1 * x_scale, y1 * y_scale, x2 * x_scale, y2 * y_scale)
            alpha = mouth_mask(height, width, scaled_box)
            alpha *= min(1.0, max(0.0, args.generated_opacity))
            generated_float = generated.astype(np.float32)
            if args.sharpen > 0:
                low_frequency = cv2.GaussianBlur(generated, (0, 0), 1.0).astype(np.float32)
                generated_float = np.clip(
                    generated_float + args.sharpen * (generated_float - low_frequency), 0, 255
                )
            refined = np.clip(generated_float * alpha + base.astype(np.float32) * (1.0 - alpha), 0, 255)
            encoder.stdin.write(np.ascontiguousarray(refined, dtype=np.uint8).tobytes())
            processed += 1

        source.release()
        assert encoder.stdin is not None
        encoder.stdin.close()
        code = encoder.wait()
        if code:
            raise RuntimeError(f"Échec de l’encodage FFmpeg (code {code}).")
        if not processed:
            raise RuntimeError("MuseTalk n’a fourni aucune image à raffiner.")
        temporary.replace(output_path)
        print(f"MuseTalk: fusion resserrée sur la bouche ({processed} images).", flush=True)
    except Exception:
        source.release()
        if encoder.poll() is None:
            encoder.kill()
            encoder.wait()
        temporary.unlink(missing_ok=True)
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
