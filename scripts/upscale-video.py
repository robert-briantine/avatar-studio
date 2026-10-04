#!/usr/bin/env python3
"""Landscape-preserving streaming Real-ESRGAN video upscale."""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
from pathlib import Path

import numpy as np


def load_vendor(tool_root: Path):
    source = tool_root / "scripts/realesrgan_video.py"
    if not source.is_file():
        raise RuntimeError(f"Script Real-ESRGAN absent: {source}")
    spec = importlib.util.spec_from_file_location("dgx_realesrgan_video", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Impossible de charger {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tool-root", required=True)
    parser.add_argument("--scale", type=int, choices=(2,), default=2)
    parser.add_argument("--tile", type=int, default=0)
    parser.add_argument("--crf", type=int, default=17)
    args = parser.parse_args()

    vendor = load_vendor(Path(args.tool_root).resolve())
    source = Path(args.input).resolve()
    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    info = vendor.probe(source)
    upsampler = vendor.model_and_upsampler("RealESRGAN_x2plus", args.scale, args.tile)
    input_width = info["width"]
    input_height = info["height"]
    output_width = input_width * args.scale
    output_height = input_height * args.scale
    frame_size = input_width * input_height * 3

    decoder = subprocess.Popen([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(source),
        "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    temporary = destination.with_name(f".{destination.name}.upscale.tmp.mp4")
    encoder = subprocess.Popen([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-video_size", f"{output_width}x{output_height}",
        "-framerate", info["fps_text"], "-i", "pipe:0", "-i", str(source),
        "-map", "0:v:0", "-map", "1:a:0?", "-vf", "setsar=1",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
        "-profile:v", "high", "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
        "-c:a", "copy", "-map_metadata", "-1", "-movflags", "+faststart", str(temporary),
    ], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    processed = 0
    report_every = max(1, info["frames"] // 100)
    try:
        assert decoder.stdout is not None
        assert encoder.stdin is not None
        while True:
            raw = vendor.read_frame(decoder.stdout, frame_size)
            if not raw:
                break
            if len(raw) != frame_size:
                raise RuntimeError("La dernière image décodée est incomplète.")
            frame = np.frombuffer(raw, dtype=np.uint8).reshape(input_height, input_width, 3)
            restored, _ = upsampler.enhance(frame, outscale=args.scale)
            encoder.stdin.write(np.ascontiguousarray(restored, dtype=np.uint8).tobytes())
            processed += 1
            if processed == 1 or processed % report_every == 0 or processed == info["frames"]:
                print(f"PROGRESS {processed} {info['frames']}", flush=True)
        encoder.stdin.close()
        decoder_code = decoder.wait()
        encoder_code = encoder.wait()
        decoder_error = decoder.stderr.read().decode(errors="replace") if decoder.stderr else ""
        encoder_error = encoder.stderr.read().decode(errors="replace") if encoder.stderr else ""
        if decoder_code:
            raise RuntimeError(f"Échec du décodage FFmpeg: {decoder_error.strip()}")
        if encoder_code:
            raise RuntimeError(f"Échec de l'encodage FFmpeg: {encoder_error.strip()}")
        if not processed:
            raise RuntimeError("Aucune image n'a été décodée.")
        temporary.replace(destination)
    except Exception:
        decoder.kill()
        encoder.kill()
        temporary.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
