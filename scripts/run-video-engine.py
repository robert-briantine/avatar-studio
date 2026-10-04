#!/usr/bin/env python3
"""Host-side launcher for the isolated avatar video engines."""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import uuid
from pathlib import Path


ACTIVE_PROCESS: subprocess.Popen[str] | None = None
ACTIVE_CONTAINER: str | None = None


def progress(value: float, message: str) -> None:
    print(f"DGX_PROGRESS {value:.1f} {message}", flush=True)


def stop_active() -> None:
    global ACTIVE_PROCESS
    if ACTIVE_CONTAINER:
        subprocess.run(
            ["docker", "rm", "-f", ACTIVE_CONTAINER],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    if ACTIVE_PROCESS and ACTIVE_PROCESS.poll() is None:
        ACTIVE_PROCESS.terminate()


def handle_stop(_signum: int, _frame: object) -> None:
    stop_active()
    raise SystemExit(143)


def run(command: list[str], cwd: Path | None = None) -> None:
    global ACTIVE_PROCESS
    print("[video-engine]", " ".join(command), flush=True)
    ACTIVE_PROCESS = subprocess.Popen(command, cwd=cwd, text=True)
    code = ACTIVE_PROCESS.wait()
    ACTIVE_PROCESS = None
    if code:
        raise RuntimeError(f"Commande arrêtée avec le code {code}: {command[0]}")


def checked_file(value: str, label: str) -> Path:
    result = Path(value).expanduser().resolve()
    if not result.is_file():
        raise RuntimeError(f"{label} introuvable: {result}")
    return result


def select_realesrgan_python(tool_root: Path) -> Path:
    configured = os.environ.get("REALESRGAN_PYTHON", "").strip()
    preferred = Path(configured).expanduser() if configured else tool_root / ".venv-ai" / "bin" / "python"
    candidates = [preferred, tool_root / ".venv-ai" / "bin" / "python"]
    checked: set[Path] = set()
    probe = (
        "import cv2, numpy, torch; "
        "from basicsr.archs.rrdbnet_arch import RRDBNet; "
        "from realesrgan import RealESRGANer"
    )
    for candidate in candidates:
        # Keep the venv's python symlink: resolving it points back to the
        # system interpreter and discards the venv site-packages.
        candidate = Path(os.path.abspath(candidate.expanduser()))
        if candidate in checked or not candidate.is_file():
            continue
        checked.add(candidate)
        try:
            result = subprocess.run(
                [str(candidate), "-c", probe],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            if configured and candidate != preferred:
                print(
                    f"[video-engine] {preferred} n’a pas les dépendances Real-ESRGAN; "
                    f"utilisation de {candidate}.",
                    flush=True,
                )
            return candidate
    raise RuntimeError(
        "Aucun Python Real-ESRGAN valide. Vérifiez REALESRGAN_PYTHON ou "
        f"l’environnement {tool_root / '.venv-ai' / 'bin' / 'python'}."
    )


def main() -> int:
    global ACTIVE_CONTAINER
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", required=True, choices=("hybrid", "longcat"))
    parser.add_argument("--image", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--engines-root", required=True)
    parser.add_argument("--app-root", required=True)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--upscale", choices=("true", "false"), default="true")
    args = parser.parse_args()

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    image = checked_file(args.image, "Image avatar")
    audio = checked_file(args.audio, "Audio")
    engines_root = Path(args.engines_root).expanduser().resolve()
    app_root = Path(args.app_root).expanduser().resolve()
    work_dir = Path(args.work_dir).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    if not engines_root.is_dir():
        raise RuntimeError(f"Dossier des moteurs absent: {engines_root}")
    if not shutil.which("docker"):
        raise RuntimeError("Docker est requis pour isoler les moteurs vidéo.")

    image_name = os.environ.get(
        "DGX_HYBRID_IMAGE" if args.engine == "hybrid" else "DGX_LONGCAT_IMAGE",
        f"dgx-avatar-{args.engine}:local",
    )
    inspect = subprocess.run(
        ["docker", "image", "inspect", image_name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if inspect.returncode:
        raise RuntimeError(
            f"Image Docker absente: {image_name}. Lance scripts/video-engines/install.sh {args.engine}."
        )

    container_script = "hybrid-video.py" if args.engine == "hybrid" else "longcat-video.py"
    raw_output = work_dir / "engine-raw.mp4"
    raw_output.unlink(missing_ok=True)
    ACTIVE_CONTAINER = f"dgx-avatar-{args.engine}-{uuid.uuid4().hex[:10]}"
    uid = os.getuid()
    gid = os.getgid()
    engine_mounts: list[str] = []
    engine_env: list[str] = []
    if args.engine == "hybrid":
        portable_preprocessing = app_root / "scripts" / "musetalk-preprocessing-portable.py"
        checked_file(str(portable_preprocessing), "Prétraitement portable MuseTalk")
        engine_env = ["-e", "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1"]
        engine_mounts = [
            "-v",
            f"{portable_preprocessing}:/engines/src/MuseTalk/musetalk/utils/preprocessing.py:ro",
        ]
    command = [
        "docker", "run", "--rm", "--name", ACTIVE_CONTAINER,
        "--gpus", "all", "--ipc", "host", "--shm-size", "24g",
        "--user", f"{uid}:{gid}",
        *engine_env,
        "-e", "HOME=/tmp/dgx-avatar-home",
        "-e", "HF_HOME=/engines/cache/huggingface",
        "-e", "TORCH_HOME=/engines/cache/torch",
        "-v", f"{engines_root}:/engines",
        "-v", f"{app_root / 'scripts'}:/runner:ro",
        "-v", f"{image}:/input/avatar{image.suffix.lower() or '.png'}:ro",
        "-v", f"{audio}:/input/voice{audio.suffix.lower() or '.wav'}:ro",
        "-v", f"{work_dir}:/job",
        *engine_mounts,
        image_name, "python", f"/runner/{container_script}",
        "--image", f"/input/avatar{image.suffix.lower() or '.png'}",
        "--audio", f"/input/voice{audio.suffix.lower() or '.wav'}",
        "--output", "/job/engine-raw.mp4",
    ]
    if args.prompt:
        command.extend(["--prompt", args.prompt])

    progress(5, f"Démarrage du moteur {args.engine} isolé…")
    try:
        run(command)
    finally:
        ACTIVE_CONTAINER = None
    if not raw_output.is_file() or raw_output.stat().st_size < 10_000:
        raise RuntimeError(f"Le moteur {args.engine} n'a produit aucune vidéo exploitable.")

    if args.upscale == "true":
        tool_root = Path(os.environ.get(
            "DGX_SHORT_MAKER_ROOT", "/home/blockapicoder/dgx-short-maker-fixed/dgx-short-maker"
        )).expanduser().resolve()
        upscale_python = select_realesrgan_python(tool_root)
        upscaler = app_root / "scripts" / "upscale-video.py"
        checked_file(str(upscale_python), "Python Real-ESRGAN")
        checked_file(str(upscaler), "Adaptateur d'upscale")
        progress(82, "Restauration et upscale IA Real-ESRGAN 2×…")
        run([
            str(upscale_python), str(upscaler),
            "--input", str(raw_output), "--output", str(output),
            "--tool-root", str(tool_root), "--scale", "2", "--crf", "17",
        ])
    else:
        progress(88, "Finalisation du MP4 sans upscale…")
        temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp.mp4")
        run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(raw_output),
            "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", str(temporary),
        ])
        temporary.replace(output)

    if not output.is_file() or output.stat().st_size < 10_000:
        raise RuntimeError("La finalisation de la vidéo a échoué.")
    progress(99, "Validation de la vidéo finale…")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        stop_active()
        print(f"[video-engine] {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
