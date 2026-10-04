#!/usr/bin/env python3
"""LivePortrait motion pass followed by MuseTalk 1.5 lip sync."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
from pathlib import Path


def run(command: list[str], cwd: Path | None = None) -> None:
    print("[hybrid]", " ".join(command), flush=True)
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
    parser.add_argument("--parsing-mode", choices=("raw", "jaw", "neck"), default="raw")
    args = parser.parse_args()

    live_root = Path("/engines/src/LivePortrait")
    muse_root = Path("/engines/src/MuseTalk")
    job = Path("/job")
    source = Path(args.image)
    audio = Path(args.audio)
    output = Path(args.output)
    required = [
        live_root / "pretrained_weights/liveportrait/base_models/appearance_feature_extractor.pth",
        live_root / "pretrained_weights/liveportrait/base_models/motion_extractor.pth",
        muse_root / "models/musetalkV15/unet.pth",
        muse_root / "models/musetalkV15/musetalk.json",
        muse_root / "models/whisper/pytorch_model.bin",
        muse_root / "models/dwpose/dw-ll_ucoco_384.pth",
    ]
    missing = [str(item) for item in required if not item.is_file()]
    if missing:
        raise RuntimeError("Poids hybrides manquants: " + ", ".join(missing))

    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:24]
    motion_cache = Path("/engines/cache/hybrid-motion")
    motion_cache.mkdir(parents=True, exist_ok=True)
    motion = motion_cache / f"{digest}.mp4"
    if not motion.is_file() or motion.stat().st_size < 10_000:
        live_output = job / "liveportrait"
        shutil.rmtree(live_output, ignore_errors=True)
        live_output.mkdir(parents=True, exist_ok=True)
        print("DGX_PROGRESS 15 LivePortrait : création d'une base de mouvement stable…", flush=True)
        run([
            "python", "inference.py", "-s", str(source),
            "-d", str(live_root / "assets/examples/driving/d0.mp4"),
            "-o", str(live_output), "--driving-multiplier", "0.65",
        ], cwd=live_root)
        candidates = sorted(
            (item for item in live_output.glob("*.mp4") if "_concat" not in item.name),
            key=lambda item: item.stat().st_mtime,
        )
        if not candidates:
            raise RuntimeError("LivePortrait n'a produit aucune base animée.")
        temporary = motion.with_suffix(".tmp.mp4")
        shutil.copyfile(candidates[-1], temporary)
        temporary.replace(motion)
    else:
        print("DGX_PROGRESS 25 LivePortrait : base de mouvement en cache réutilisée…", flush=True)

    muse_output = job / "musetalk"
    shutil.rmtree(muse_output, ignore_errors=True)
    muse_output.mkdir(parents=True, exist_ok=True)
    config = job / "musetalk-task.yaml"
    config.write_text(
        "task_0:\n"
        f"  video_path: {str(motion)!r}\n"
        f"  audio_path: {str(audio)!r}\n"
        "  result_name: hybrid-lipsync.mp4\n",
        encoding="utf-8",
    )
    print("DGX_PROGRESS 32 MuseTalk 1.5 : synchronisation labiale sur toute la piste audio…", flush=True)
    run([
        "python", "-m", "scripts.inference",
        "--inference_config", str(config),
        "--result_dir", str(muse_output),
        "--unet_model_path", "models/musetalkV15/unet.pth",
        "--unet_config", "models/musetalkV15/musetalk.json",
        "--whisper_dir", "models/whisper",
        "--version", "v15", "--use_float16", "--batch_size", "8",
        "--parsing_mode", args.parsing_mode,
        "--ffmpeg_path", "/usr/bin",
    ], cwd=muse_root)
    generated = muse_output / "v15/hybrid-lipsync.mp4"
    if not generated.is_file() or generated.stat().st_size < 10_000:
        raise RuntimeError("MuseTalk n'a produit aucune vidéo exploitable.")

    refined = muse_output / "hybrid-lipsync-refined.mp4"
    print("DGX_PROGRESS 73 Fusion de MuseTalk limitée aux lèvres pour préserver le visage…", flush=True)
    run([
        "python", "/runner/refine-musetalk.py",
        "--motion", str(motion), "--generated", str(generated), "--output", str(refined),
    ])

    print("DGX_PROGRESS 76 Remux de la voix originale et coupe à la durée exacte…", flush=True)
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(refined), "-i", str(audio), "-t", f"{duration(audio):.6f}",
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(output),
    ])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
