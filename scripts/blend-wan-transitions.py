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


def fit_reference(reference, width, height):
    """Match ComfyUI's centered reference framing to the generated video."""
    if reference is None or reference.ndim != 3 or reference.shape[2] < 3:
        raise ValueError("L'image avatar de référence est illisible.")
    reference = reference[:, :, :3]
    source_height, source_width = reference.shape[:2]
    if source_width < 1 or source_height < 1:
        raise ValueError("L'image avatar de référence est vide.")
    scale = max(width / source_width, height / source_height)
    resized_width = max(width, round(source_width * scale))
    resized_height = max(height, round(source_height * scale))
    resized = cv2.resize(reference, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
    left = (resized_width - width) // 2
    top = (resized_height - height) // 2
    return resized[top:top + height, left:left + width].copy()


def prepare_colour_guard(reference):
    """Protect every red accent that was already present in the avatar."""
    rgb = reference.astype(np.float32)
    red, green, blue = (rgb[:, :, index] for index in range(3))
    other = np.maximum(green, blue)
    saturation = rgb.max(axis=2) - rgb.min(axis=2)
    # Do not classify warm skin or ordinary lips as a protected red object.
    # Natural colours do not meet the repair threshold anyway; this mask is for
    # truly saturated source details such as a red garment, LED or lipstick.
    present = ((red >= 110) & (red - other >= 55) & (saturation >= 68)).astype(np.uint8)
    # Generated poses move a few pixels around the exact source position. A
    # generous guard keeps the avatar's intentional red lights, clothes or lips.
    protected = cv2.dilate(present, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))) > 0
    return protected


def repair_unexpected_red(frame, reference, protected_red, clean_frame=None):
    """Replace solid-red hallucinations with the last clean local texture.

    Wan can occasionally paint an open mouth pure red for part of one native
    block. Only strong red regions absent from the source avatar are touched.
    Reusing the last unaffected frame (or the source avatar as a fallback)
    avoids turning the detected region into a flat gray patch. This filter is a
    safety net; the clean handoff control is responsible for preventing the
    hallucination in newly generated videos.
    """
    rgb = frame.astype(np.float32)
    red, green, blue = (rgb[:, :, index] for index in range(3))
    other = np.maximum(green, blue)
    saturation = rgb.max(axis=2) - rgb.min(axis=2)
    red_excess = red - other

    # The thresholds deliberately ignore ordinary skin and natural pink lips.
    candidate = ((red >= 150) & (red_excess >= 72) & (saturation >= 92) & ~protected_red)
    components, labels, stats, _ = cv2.connectedComponentsWithStats(candidate.astype(np.uint8), 8)
    kept = np.zeros(candidate.shape, dtype=np.uint8)
    minimum_area = max(10, round(frame.shape[0] * frame.shape[1] * 0.00006))
    for label in range(1, components):
        if stats[label, cv2.CC_STAT_AREA] >= minimum_area:
            kept[labels == label] = 255
    if not np.any(kept):
        return frame, 0

    # Once a solid-red core is proven, include its less saturated compression
    # halo and the interior it has overwritten. Conditioning alpha again on the
    # corrupted colour left a red outline and a flat center in the Robert test.
    # The component itself is already a conservative proof, so its local repair
    # mask can use the complete clean donor texture.
    expanded = cv2.dilate(kept, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    alpha = cv2.GaussianBlur(expanded.astype(np.float32) / 255, (0, 0), 1.35)
    alpha[protected_red] = 0

    donor = clean_frame if clean_frame is not None and clean_frame.shape == frame.shape else reference
    donor = donor.astype(np.float32)
    repaired = rgb * (1 - alpha[:, :, None]) + donor * alpha[:, :, None]
    return np.rint(np.clip(repaired, 0, 255)).astype(np.uint8), int(np.count_nonzero(alpha > 0.05))


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
    if not math.isfinite(duration) or duration <= 0 or fps <= 0 or len(windows) < 1:
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


def assemble(input_path, audio_path, output_path, windows, duration, fps, reference_path=None):
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
    repaired_frames = 0
    repaired_pixels = 0
    last_clean_frame = None
    luminance_reference = None
    luminance_average = None
    reference = protected_red = None
    if reference_path:
        loaded = cv2.imread(reference_path, cv2.IMREAD_COLOR)
        reference = fit_reference(cv2.cvtColor(loaded, cv2.COLOR_BGR2RGB) if loaded is not None else None,
                                  width, height)
        protected_red = prepare_colour_guard(reference)
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
                nonlocal written, repaired_frames, repaired_pixels, last_clean_frame
                nonlocal luminance_reference, luminance_average
                if reference is not None:
                    frame, pixels = repair_unexpected_red(
                        frame, reference, protected_red, last_clean_frame
                    )
                    if pixels:
                        repaired_frames += 1
                        repaired_pixels += pixels
                    else:
                        # Keep a donor from before the hallucination. Updating it
                        # with repaired frames would recursively freeze softened
                        # or partly contaminated texture into later images.
                        last_clean_frame = frame.copy()
                # Long native Extend chains can slowly change exposure from
                # block to block. Track robust frame luminance with a ~2.5 s
                # low-pass filter and compensate in Y only (not chroma).
                ycc = cv2.cvtColor(frame, cv2.COLOR_RGB2YCrCb)
                frame_luma = float(np.median(ycc[:, :, 0]))
                if luminance_reference is None:
                    luminance_reference = frame_luma
                    luminance_average = frame_luma
                else:
                    smoothing = 1.0 - math.exp(-1.0 / (fps * 2.5))
                    luminance_average += smoothing * (frame_luma - luminance_average)
                correction = float(np.clip(luminance_reference - luminance_average, -48, 48))
                if abs(correction) >= 0.25:
                    ycc[:, :, 0] = np.clip(ycc[:, :, 0].astype(np.float32) + correction, 0, 255).astype(np.uint8)
                    frame = cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB)
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

            if written != expected_frames:
                raise ValueError("Nombre de frames inattendu pendant l'assemblage vidéo.")
            # Wan rounds the final native chunk up to 77 frames. Discard only
            # complete trailing frames beyond the requested audio duration.
            while True:
                trailing = decoder.stdout.read(frame_bytes)
                if not trailing:
                    break
                if len(trailing) != frame_bytes:
                    raise ValueError("La dernière frame de remplissage du MP4 est tronquée.")
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
    if repaired_frames:
        print(json.dumps({"colour_guard_frames": repaired_frames,
                          "colour_guard_pixels": repaired_pixels}), file=sys.stderr)
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
    parser.add_argument("--reference")
    args = parser.parse_args()
    cv2.setNumThreads(2)
    frames = assemble(args.input, args.audio, args.output, json.loads(args.windows), args.duration, args.fps,
                      args.reference)
    print(json.dumps({"frames": frames, "fps": args.fps}))


if __name__ == "__main__":
    def stop(_signal, _frame):
        raise SystemExit(143)  # Let finally terminate the two FFmpeg processes.
    signal.signal(signal.SIGTERM, stop)
    main()
