"""Build labelled comparison videos for the four already-verified montages."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
variants = json.loads((ROOT / "variantes.json").read_text())["variants"]
font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
args = ["ffmpeg", "-v", "error", "-y"]
filters = []
for index, variant in enumerate(variants):
    args.extend(["-i", str(ROOT / variant["file"])])
    label = ROOT / f".legende-{index + 1}.txt"
    label.write_text(f"{index + 1} · {variant['title']}")
    filters.append(f"[{index}:v]pad=512:324:0:36:black,drawtext=fontfile={font}:textfile={label}:fontsize=22:fontcolor=white:x=12:y=7[v{index}]")
filters.append("[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0:shortest=1[v]")
output = ROOT / "comparaison-4-variantes.mp4"
try:
    subprocess.run(args + ["-filter_complex", ";".join(filters), "-map", "[v]", "-map", "0:a:0",
                          "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
                          "-c:a", "copy", "-movflags", "+faststart", str(output)], check=True)
finally:
    for index in range(4):
        (ROOT / f".legende-{index + 1}.txt").unlink(missing_ok=True)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(output), "-an", "-vf",
                "trim=start=8.9:end=10.7,setpts=2*(PTS-STARTPTS),fps=48",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", str(ROOT / "comparaison-raccord-2-ralenti.mp4")], check=True)
print(str(output))
