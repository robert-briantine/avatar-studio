"""Create review montages only; the application and source video stay untouched."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parent
INFO = json.loads((ROOT / "source.json").read_text())
SOURCE = Path(INFO["projectRoot"]) / INFO["generation"]["video"]["path"]
FPS = INFO["fps"]
WIDTH, HEIGHT = 512, 288
COLOUR_FLAGS = "accurate_rnd+full_chroma_int+full_chroma_inp"
QUANTILES = [0, 5, 15, 30, 50, 70, 85, 95, 100]
GRID = np.stack(np.meshgrid(np.arange(WIDTH), np.arange(HEIGHT)), axis=-1).astype(np.float32)


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def smoothstep(value):
    value = float(np.clip(value, 0, 1))
    return value * value * (3 - 2 * value)


def background_profile(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    background = np.concatenate([gray[:, :int(WIDTH * .25)].ravel(), gray[:, int(WIDTH * .84):].ravel()])
    return np.percentile(background, QUANTILES)


def lighting(frame, context, index):
    start, cut, end = context["start"], context["cut"], context["end"]
    phase = smoothstep((index - start) / (end - start))
    target = context["before"] * (1 - phase) + context["after"] * phase
    source = background_profile(frame)
    values, groups, counts = np.unique(source, return_inverse=True, return_counts=True)
    levels = np.bincount(groups, weights=target) / counts
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    # Reference the static background, so head movement does not drive exposure.
    strength = smoothstep((index - start) / max(1, cut - start))
    strength *= 1 - smoothstep((index - cut - .55 * FPS) / (.55 * FPS))
    shift = np.clip(np.interp(gray, values, levels - values), -12, 12) * strength
    return np.rint(np.clip(frame.astype(np.float32) + shift[:, :, None], 0, 255)).astype(np.uint8)


class Motion:
    def __init__(self, first, second):
        self.first, self.second = first, second
        a, b = (cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) for frame in (first, second))
        self.forward = cv2.calcOpticalFlowFarneback(a, b, None, .5, 5, 25, 5, 7, 1.5, 0)
        self.backward = cv2.calcOpticalFlowFarneback(b, a, None, .5, 5, 25, 5, 7, 1.5, 0)

    @staticmethod
    def warp(frame, flow, amount):
        coords = GRID.copy()
        for _ in range(3):
            sampled = cv2.remap(flow, coords, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            coords = GRID - amount * sampled
        return cv2.remap(frame, coords, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)

    def blend(self, phase):
        if phase <= 0:
            return self.first
        if phase >= 1:
            return self.second
        first = self.warp(self.first, self.forward, phase)
        second = self.warp(self.second, self.backward, 1 - phase)
        return cv2.addWeighted(first, 1 - phase, second, phase, 0)

def audio_hash(path):
    data = run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
                "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], capture_output=True).stdout
    return hashlib.sha256(data).hexdigest()


def encode(path, source_frames, changed):
    with tempfile.TemporaryDirectory(prefix=".montage-", dir=ROOT) as temporary:
        visual = Path(temporary) / "visual.mp4"
        with tempfile.TemporaryFile() as log:
            encoder = subprocess.Popen([
                "ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0", "-an",
                "-vf", f"scale=in_range=pc:out_range=tv:flags={COLOUR_FLAGS}",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", str(visual),
            ], stdin=subprocess.PIPE, stderr=log)
            try:
                for index, frame in enumerate(source_frames):
                    encoder.stdin.write(changed.get(index, frame).tobytes())
                encoder.stdin.close()
                if encoder.wait() != 0:
                    log.seek(0)
                    raise RuntimeError(log.read().decode(errors="replace"))
            finally:
                if encoder.poll() is None:
                    encoder.kill()
                    encoder.wait()
        run(["ffmpeg", "-v", "error", "-y", "-i", str(visual), "-i", str(SOURCE),
             "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", str(path)])


def main():
    cv2.setNumThreads(2)
    source_bytes = run([
        "ffmpeg", "-v", "error", "-i", str(SOURCE), "-an",
        "-vf", f"scale=out_range=pc:flags={COLOUR_FLAGS}", "-fps_mode", "passthrough",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
    ], capture_output=True).stdout
    frames = np.frombuffer(source_bytes, dtype=np.uint8).reshape(-1, HEIGHT, WIDTH, 3)
    expected = sum(block["frames"] for block in INFO["plan"])
    if len(frames) != expected:
        raise RuntimeError(f"Nombre d’images source incorrect : {len(frames)}/{expected}")
    shutil.copy2(SOURCE, ROOT / "00-reference-originale.mp4")
    contexts = []
    for block in INFO["plan"][:-1]:
        cut = block["startFrame"] + block["frames"]
        contexts.append({
            "cut": cut, "start": cut - 8, "end": cut + 53,
            "before": np.median([background_profile(frames[cut - offset]) for offset in (24, 12, 3)], axis=0),
            "after": np.median([background_profile(frames[cut + offset]) for offset in (40, 48, 56)], axis=0),
        })
    descriptions = [
        ("01-fondu-court.mp4", "Fondu court", "Fondu de 0,20 s au début du morceau suivant ; lumière progressive autour de la reprise."),
        ("02-fondu-doux.mp4", "Fondu doux", "Fondu de 0,40 s ; reprise plus progressive, avec un risque de dédoublement pendant le fondu."),
        ("03-mouvement-interpole.mp4", "Mouvement interpolé", "Interpolation du mouvement à 48 images/s pendant la reprise, puis morphing de pose sur 0,30 s."),
        ("04-reprise-reconstruite.mp4", "Reprise reconstruite", "Reconstruit la fin de pause et les premières 0,375 s du morceau suivant entre deux poses réelles ; évite les images instables du départ, mais peut décaler les premiers mouvements de bouche."),
    ]
    interpolated = {}
    for context in contexts:
        cut = context["cut"]
        for first in range(cut, context["end"] + 1, 3):
            motion = Motion(frames[first], frames[first + 3])
            interpolated[first] = frames[first]
            interpolated[first + 1] = motion.blend(1 / 3)
            interpolated[first + 2] = motion.blend(2 / 3)
    original_audio = audio_hash(SOURCE)
    reports = []
    for number, (filename, title, description) in enumerate(descriptions, 1):
        print(f"Création {number}/4 : {title}", flush=True)
        changed = {}
        for context in contexts:
            cut = context["cut"]
            anchor = frames[cut - 1]
            stable_start, stable_end = cut - 6, cut + 18
            reconstruction = Motion(frames[stable_start], frames[stable_end]) if number == 4 else None
            for index in range(context["start"], context["end"] + 1):
                current = interpolated.get(index, frames[index]) if number >= 3 else frames[index]
                if number == 4 and stable_start <= index <= stable_end:
                    current = reconstruction.blend(smoothstep((index - stable_start) / (stable_end - stable_start)))
                if index >= cut:
                    elapsed = (index - cut) / FPS
                    if number <= 2:
                        duration = .20 if number == 1 else .40
                        phase = smoothstep(elapsed / duration)
                        current = cv2.addWeighted(anchor, 1 - phase, current, phase, 0)
                    elif number == 3 and elapsed < .30:
                        current = Motion(anchor, current).blend(smoothstep(elapsed / .30))
                changed[index] = lighting(current, context, index)
        path = ROOT / filename
        encode(path, frames, changed)
        identical_audio = audio_hash(path) == original_audio
        if not identical_audio:
            raise RuntimeError(f"La piste audio de {filename} a changé.")
        metadata = json.loads(run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                                  "-show_entries", "stream=nb_read_frames,avg_frame_rate,duration", "-of", "json", str(path)], capture_output=True, text=True).stdout)["streams"][0]
        if int(metadata["nb_read_frames"]) != len(frames) or metadata["avg_frame_rate"] != f"{FPS}/1":
            raise RuntimeError(f"Cadence ou durée incorrecte : {filename}")
        reports.append({"number": number, "file": filename, "title": title, "description": description,
                        "frames": len(frames), "fps": FPS, "duration": metadata["duration"], "audioIdentical": identical_audio})
    (ROOT / "variantes.json").write_text(json.dumps({"source": str(SOURCE), "junctions": [c["cut"] / FPS for c in contexts],
                                                    "variants": reports}, ensure_ascii=False, indent=2))
    (ROOT / "04-reprise-stabilisee.mp4").unlink(missing_ok=True)
    print(json.dumps(reports, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
