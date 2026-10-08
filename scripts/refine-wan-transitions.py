"""Stream the selected transition treatment using bounded lookahead."""
import argparse
from fractions import Fraction
import json
import signal
import subprocess
import tempfile

import cv2
import numpy as np

from wan_transition_effects import refine_window, transition_windows

COLOUR_FLAGS = "accurate_rnd+full_chroma_int+full_chroma_inp"


def refine_video(input_path, output_path, boundaries, style):
    if style not in ("interpolated", "reconstructed"):
        raise ValueError("Style de transition inconnu.")
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
                            "-show_entries", "stream=width,height,avg_frame_rate,nb_read_frames", "-of", "json", input_path],
                           check=True, capture_output=True, text=True)
    stream = json.loads(probe.stdout)["streams"][0]
    width, height = stream["width"], stream["height"]
    fps = float(Fraction(stream["avg_frame_rate"]))
    count = int(stream["nb_read_frames"])
    if fps != 48:
        raise ValueError("Les transitions validées nécessitent une vidéo à 48 images/s.")
    windows = transition_windows(boundaries, fps, count)
    decoder = encoder = None
    with tempfile.TemporaryFile() as decode_log, tempfile.TemporaryFile() as encode_log:
        try:
            decoder = subprocess.Popen([
                "ffmpeg", "-v", "error", "-nostdin", "-i", input_path, "-map", "0:v:0",
                "-vf", f"scale=out_range=pc:flags={COLOUR_FLAGS}", "-fps_mode", "passthrough",
                "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
            ], stdout=subprocess.PIPE, stderr=decode_log)
            encoder = subprocess.Popen([
                "ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", "-an",
                "-vf", f"scale=in_range=pc:out_range=tv:flags={COLOUR_FLAGS}",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", output_path,
            ], stdin=subprocess.PIPE, stderr=encode_log)
            buffer, changed = {}, {}
            read_index, window_index = 0, 0

            def read_until(last):
                nonlocal read_index
                while read_index <= last:
                    data = decoder.stdout.read(width * height * 3)
                    if len(data) != width * height * 3:
                        raise ValueError("Une image de reprise est absente ou tronquée.")
                    buffer[read_index] = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
                    read_index += 1

            for index in range(count):
                if window_index < len(windows) and index == windows[window_index]["start"]:
                    window = windows[window_index]
                    read_until(window["read_end"])
                    changed = refine_window(buffer, window, style)
                    window_index += 1
                read_until(index)
                frame = changed.pop(index, buffer[index])
                encoder.stdin.write(frame.tobytes())
                # Raw samples are retained only for the next reference window.
                oldest = index - round(fps * .5)
                for past in [key for key in buffer if key < oldest]:
                    del buffer[past]
            decoder.stdout.close()
            encoder.stdin.close()
            if any(code != 0 for code in (decoder.wait(), encoder.wait())):
                decode_log.seek(0)
                encode_log.seek(0)
                raise RuntimeError((decode_log.read() + encode_log.read()).decode(errors="replace")[-2000:])
            return count
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
    parser.add_argument("--boundaries", required=True)
    parser.add_argument("--style", required=True, choices=["interpolated", "reconstructed"])
    args = parser.parse_args()
    cv2.setNumThreads(2)
    count = refine_video(args.input, args.output, json.loads(args.boundaries), args.style)
    print(json.dumps({"frames": count, "transitionStyle": args.style}))


if __name__ == "__main__":
    def stop(_signal, _frame):
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, stop)
    main()
