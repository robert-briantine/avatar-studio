"""Assemble overlapping Wan windows without changing the audio timeline."""
import argparse
import json
import math
import signal
import subprocess
import sys
import tempfile
from fractions import Fraction

import cv2
import numpy as np


def blend_frames(previous, following, alpha):
    """Warp both poses towards an intermediate pose before blending them."""
    if alpha <= 0:
        return previous
    if alpha >= 1:
        return following
    alpha = alpha * alpha * (3 - 2 * alpha)
    gray_a = cv2.cvtColor(previous, cv2.COLOR_RGB2GRAY)
    gray_b = cv2.cvtColor(following, cv2.COLOR_RGB2GRAY)
    forward = cv2.calcOpticalFlowFarneback(gray_a, gray_b, None, 0.5, 5, 25, 5, 7, 1.5, 0)
    backward = cv2.calcOpticalFlowFarneback(gray_b, gray_a, None, 0.5, 5, 25, 5, 7, 1.5, 0)
    height, width = gray_a.shape
    grid = np.stack(np.meshgrid(np.arange(width), np.arange(height)), axis=-1).astype(np.float32)

    def warp(frame, flow, amount):
        # Solve the inverse mapping, rather than treating forward flow as an
        # inverse map. This helps preserve edges when the head changes pose.
        coords = grid.copy()
        for _ in range(3):
            sampled = cv2.remap(flow, coords, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            coords = grid - amount * sampled
        return cv2.remap(frame, coords, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)

    a = warp(previous, forward, alpha)
    b = warp(following, backward, 1 - alpha)
    return cv2.addWeighted(a, 1 - alpha, b, alpha, 0)


def validate_windows(windows, duration, fps):
    if not math.isfinite(duration) or duration <= 0 or fps <= 0 or len(windows) < 2:
        raise ValueError("Durée, cadence ou fenêtres de transition invalides.")
    end = 0
    for index, window in enumerate(windows):
        start, frames = window["startFrame"], window["frames"]
        if type(start) is not int or type(frames) is not int or start < 0 or frames < 1:
            raise ValueError("Les positions vidéo doivent être des nombres entiers de frames.")
        if index == 0:
            if start != 0:
                raise ValueError("La première fenêtre doit commencer à zéro.")
        elif not (2 <= end - start < min(frames, windows[index - 1]["frames"])):
            raise ValueError("Chevauchement vidéo absent ou invalide.")
        end = start + frames
    if end != math.ceil(duration * fps):
        raise ValueError("La durée des fenêtres ne correspond pas à celle de l'audio.")
    return end


def assemble(input_path, audio_path, output_path, windows, duration, fps):
    expected_frames = validate_windows(windows, duration, fps)
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,r_frame_rate", "-of", "json", input_path,
    ], check=True, capture_output=True, text=True)
    stream = json.loads(probe.stdout)["streams"][0]
    width, height = stream["width"], stream["height"]
    if not math.isclose(float(Fraction(stream["r_frame_rate"])), fps):
        raise ValueError("La cadence du MP4 ne correspond pas au workflow Wan.")
    frame_bytes = width * height * 3
    written = 0
    decoder = encoder = None
    with tempfile.TemporaryFile() as decode_log, tempfile.TemporaryFile() as encode_log:
        try:
            decoder = subprocess.Popen([
                "ffmpeg", "-v", "error", "-i", input_path, "-map", "0:v:0",
                "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
            ], stdout=subprocess.PIPE, stderr=decode_log)
            encoder = subprocess.Popen([
                "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", "-i", audio_path,
                "-map", "0:v:0", "-map", "1:a:0", "-t", f"{duration:.6f}",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output_path,
            ], stdin=subprocess.PIPE, stderr=encode_log)

            def read_frame():
                data = decoder.stdout.read(frame_bytes)
                if len(data) != frame_bytes:
                    raise ValueError("Le MP4 intermédiaire ne contient pas toutes les frames attendues.")
                return np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)

            def write_frame(frame):
                nonlocal written
                encoder.stdin.write(frame.tobytes())
                written += 1

            tail = []
            for index, window in enumerate(windows):
                overlap = len(tail)
                for i, previous in enumerate(tail):
                    write_frame(blend_frames(previous, read_frame(), i / (overlap - 1)))
                tail = []
                keep = (window["startFrame"] + window["frames"] - windows[index + 1]["startFrame"]
                        if index + 1 < len(windows) else 0)
                # Only the short overlap stays in memory, even for long videos.
                for _ in range(window["frames"] - overlap - keep):
                    write_frame(read_frame())
                tail = [read_frame() for _ in range(keep)]

            if written != expected_frames or decoder.stdout.read(1):
                raise ValueError("Nombre de frames inattendu pendant l'assemblage vidéo.")
            decoder.stdout.close()
            encoder.stdin.close()
            if decoder.wait() != 0 or encoder.wait() != 0:
                raise RuntimeError("FFmpeg n'a pas terminé l'assemblage vidéo.")
        except Exception as error:
            encode_log.seek(0)
            decode_log.seek(0)
            details = (decode_log.read() + encode_log.read()).decode(errors="replace")[-2000:]
            raise RuntimeError(f"{error}\n{details}") from error
        finally:
            for process in (decoder, encoder):
                if process is not None and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    return written


def main():
    if sys.argv[1:] == ["--check"]:
        print(f"OpenCV {cv2.__version__} prêt")
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--windows", required=True)
    parser.add_argument("--duration", required=True, type=float)
    parser.add_argument("--fps", required=True, type=int)
    args = parser.parse_args()
    cv2.setNumThreads(2)
    frames = assemble(args.input, args.audio, args.output, json.loads(args.windows), args.duration, args.fps)
    print(json.dumps({"frames": frames, "fps": args.fps}))


if __name__ == "__main__":
    def stop(_signal, _frame):
        raise SystemExit(143)  # Let finally terminate the two FFmpeg processes.
    signal.signal(signal.SIGTERM, stop)
    main()
