"""Match only a Wan handoff or FLF bridge to its real boundary images."""
import argparse
import json
import math
import signal
import subprocess
import tempfile
from fractions import Fraction

import cv2
import numpy as np


QUANTILES = [0, 1, 10, 25, 50, 75, 90, 95, 99, 100]
MAX_LIGHTING_SHIFT = 24
COLOUR_FLAGS = "accurate_rnd+full_chroma_int+full_chroma_inp"


def lighting_profile(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return np.percentile(gray[::2, ::2], QUANTILES)


def match_frame_lighting(frame, target, strength=1):
    if strength <= 0:
        return frame
    source = lighting_profile(frame)
    values, groups, counts = np.unique(source, return_inverse=True, return_counts=True)
    # Flat shadows can share several quantiles. Merge them before interpolation.
    levels = np.bincount(groups, weights=target) / counts
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    shift = np.interp(gray, values, levels - values)
    shift = np.clip(shift, -MAX_LIGHTING_SHIFT, MAX_LIGHTING_SHIFT) * strength
    # The same bounded shift goes to all three channels. No chroma conversion,
    # coloured masks, donor patches or exposure feedback into subsequent frames.
    return np.rint(np.clip(frame.astype(np.float32) + shift[:, :, None], 0, 255)).astype(np.uint8)


def handoff_strength(seconds, duration):
    # Native S2V settles during its first half second: hold for 250 ms, then fade.
    phase = np.clip((seconds / duration - 0.5) * 2, 0, 1)
    return float(1 - phase * phase * (3 - 2 * phase))


def match_video(input_path, output_path, start_path, end_path=None, handoff_seconds=0.5):
    if not math.isfinite(handoff_seconds) or handoff_seconds <= 0:
        raise ValueError("Durée de reprise lumineuse invalide.")
    decoder = encoder = None
    try:
        probe_args = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                      "stream=width,height,avg_frame_rate,nb_frames,nb_read_frames", "-of", "json", input_path]
        probe = subprocess.run(probe_args, check=True, capture_output=True, text=True)
        stream = json.loads(probe.stdout)["streams"][0]
        if not str(stream.get("nb_frames", "")).isdigit():
            probe = subprocess.run(probe_args[:1] + ["-count_frames"] + probe_args[1:],
                                   check=True, capture_output=True, text=True)
            stream = json.loads(probe.stdout)["streams"][0]
        fps = float(Fraction(stream["avg_frame_rate"]))
        width, height = stream["width"], stream["height"]
        count = stream.get("nb_frames")
        frames = int(count if str(count).isdigit() else stream["nb_read_frames"])
        if not math.isfinite(fps) or fps <= 0 or frames < 1:
            raise ValueError("Cadence ou nombre d’images de raccord invalide.")

        def load_reference(reference_path):
            image = cv2.imread(reference_path, cv2.IMREAD_COLOR)
            if image is None or image.shape != (height, width, 3):
                raise ValueError("L’image de raccord ne correspond pas à la vidéo.")
            return image

        start = load_reference(start_path)
        end = load_reference(end_path) if end_path else None
        start_profile = lighting_profile(start)
        end_profile = lighting_profile(end) if end is not None else None
        with tempfile.TemporaryFile() as log, tempfile.TemporaryFile() as decode_log:
            # Use the same FFmpeg conversion as boundary-image extraction.
            # OpenCV's video decoder can shift dark RGB levels by a few values.
            decoder = subprocess.Popen([
                "ffmpeg", "-v", "error", "-nostdin", "-i", input_path, "-map", "0:v:0",
                "-vf", f"scale=out_range=pc:flags={COLOUR_FLAGS}",
                "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
            ], stdout=subprocess.PIPE, stderr=decode_log)
            encoder = subprocess.Popen([
                "ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", "-an",
                "-vf", f"scale=in_range=pc:out_range=tv:flags={COLOUR_FLAGS}",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", output_path,
            ], stdin=subprocess.PIPE, stderr=log)
            index = 0
            while True:
                data = decoder.stdout.read(width * height * 3)
                if not data:
                    break
                if len(data) != width * height * 3:
                    raise ValueError("Une image de raccord est tronquée.")
                frame = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
                if end is not None:
                    phase = index / max(1, frames - 1)
                    phase = phase * phase * (3 - 2 * phase)
                    target = start_profile * (1 - phase) + end_profile * phase
                    frame = match_frame_lighting(frame, target)
                elif index / fps < handoff_seconds:
                    frame = match_frame_lighting(frame, start_profile, handoff_strength(index / fps, handoff_seconds))
                if index == 0:
                    frame = start
                elif end is not None and index == frames - 1:
                    frame = end
                encoder.stdin.write(frame.tobytes())
                index += 1
            encoder.stdin.close()
            decoder.stdout.close()
            codes = (decoder.wait(), encoder.wait())
            if any(code != 0 for code in codes):
                log.seek(0)
                decode_log.seek(0)
                raise RuntimeError((decode_log.read() + log.read()).decode(errors="replace")[-2000:])
            if index != frames:
                raise ValueError("La vidéo de raccord ne contient pas toutes les images attendues.")
            return index
    finally:
        for process in (decoder, encoder):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end")
    args = parser.parse_args()
    cv2.setNumThreads(2)
    match_video(args.input, args.output, args.start, args.end)


if __name__ == "__main__":
    def stop(_signal, _frame):
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, stop)
    main()
