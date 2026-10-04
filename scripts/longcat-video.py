#!/usr/bin/env python3
"""LongCat-Video-Avatar 1.5 480p long-form launcher."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path


def run(command: list[str], cwd: Path | None = None) -> None:
    print("[longcat]", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def duration(file: Path) -> float:
    value = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(file),
    ], text=True)
    return float(value.strip())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--prompt", default="")
    args = parser.parse_args()

    root = Path("/engines/src/LongCat-Video")
    base = root / "weights/LongCat-Video"
    avatar = root / "weights/LongCat-Video-Avatar-1.5"
    job = Path("/job")
    source = Path(args.image)
    audio = Path(args.audio)
    output = Path(args.output)
    required = [
        base / "tokenizer", base / "text_encoder", base / "vae",
        avatar / "base_model_int8", avatar / "lora/dmd_lora.safetensors",
        avatar / "whisper-large-v3", avatar / "vocal_separator/Kim_Vocal_2.onnx",
    ]
    missing = [str(item) for item in required if not item.exists()]
    if missing:
        raise RuntimeError("Poids LongCat manquants: " + ", ".join(missing))

    seconds = duration(audio)
    # Avatar 1.5 emits 93 frames first, then 80 new frames per continuation at 25 fps.
    segments = max(1, math.ceil(max(0.0, seconds * 25 - 93) / 80) + 1)
    prompt = args.prompt.strip() or (
        "The same person from the reference image speaks naturally to the camera. "
        "Stable identity, natural blinking and subtle head motion, unchanged clothes and background, "
        "realistic skin texture, stable lighting, precise lip synchronization, fixed camera."
    )
    task = job / "longcat-task.json"
    task.write_text(json.dumps({
        "prompt": prompt,
        "cond_image": str(source),
        "cond_audio": {"person1": str(audio)},
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    render_dir = job / "longcat-output"
    render_dir.mkdir(parents=True, exist_ok=True)

    print(
        f"DGX_PROGRESS 12 LongCat 1.5 INT8 : {segments} segment(s) 480p, 8 étapes distillées…",
        flush=True,
    )
    run([
        "torchrun", "--standalone", "--nproc_per_node=1",
        "run_demo_avatar_single_audio_to_video.py",
        "--context_parallel_size=1",
        f"--checkpoint_dir={avatar}",
        "--stage_1=ai2v", f"--input_json={task}", f"--output_dir={render_dir}",
        "--resolution=480p", f"--num_segments={segments}",
        "--ref_img_index=30", "--mask_frame_range=3",
        "--use_distill", "--model_type=avatar-v1.5", "--use_int8",
    ], cwd=root)
    generated = render_dir / (f"video_continue_{segments}.mp4" if segments > 1 else "ai2v_demo_1.mp4")
    if not generated.is_file() or generated.stat().st_size < 10_000:
        raise RuntimeError(f"Sortie LongCat absente: {generated}")

    print("DGX_PROGRESS 76 LongCat terminé : coupe exacte et restauration de la voix originale…", flush=True)
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(generated), "-i", str(audio), "-t", f"{seconds:.6f}",
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(output),
    ])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

