"""The two transition treatments approved in montages 3 and 4."""
import numpy as np
import cv2


QUANTILES = [0, 5, 15, 30, 50, 70, 85, 95, 100]


def smoothstep(value):
    value = float(np.clip(value, 0, 1))
    return value * value * (3 - 2 * value)


def background_profile(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    width = frame.shape[1]
    background = np.concatenate([gray[:, :max(1, int(width * .25))].ravel(),
                                 gray[:, int(width * .84):].ravel()])
    return np.percentile(background, QUANTILES)


def lighting(frame, context, index):
    start, cut, end = context["start"], context["cut"], context["end"]
    phase = smoothstep((index - start) / max(1, end - start))
    target = context["before"] * (1 - phase) + context["after"] * phase
    source = background_profile(frame)
    values, groups, counts = np.unique(source, return_inverse=True, return_counts=True)
    levels = np.bincount(groups, weights=target) / counts
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    strength = smoothstep((index - start) / max(1, cut - start))
    strength *= 1 - smoothstep((index - cut - .55 * context["fps"]) / (.55 * context["fps"]))
    shift = np.clip(np.interp(gray, values, levels - values), -12, 12) * strength
    return np.rint(np.clip(frame.astype(np.float32) + shift[:, :, None], 0, 255)).astype(np.uint8)


class Motion:
    def __init__(self, first, second):
        self.first, self.second = first, second
        height, width = first.shape[:2]
        self.grid = np.stack(np.meshgrid(np.arange(width), np.arange(height)), axis=-1).astype(np.float32)
        a, b = (cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) for frame in (first, second))
        self.forward = cv2.calcOpticalFlowFarneback(a, b, None, .5, 5, 25, 5, 7, 1.5, 0)
        self.backward = cv2.calcOpticalFlowFarneback(b, a, None, .5, 5, 25, 5, 7, 1.5, 0)

    def warp(self, frame, flow, amount):
        coords = self.grid.copy()
        for _ in range(3):
            sampled = cv2.remap(flow, coords, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            coords = self.grid - amount * sampled
        return cv2.remap(frame, coords, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)

    def blend(self, phase):
        if phase <= 0:
            return self.first
        if phase >= 1:
            return self.second
        first = self.warp(self.first, self.forward, phase)
        second = self.warp(self.second, self.backward, 1 - phase)
        return cv2.addWeighted(first, 1 - phase, second, phase, 0)


def transition_windows(boundaries, fps, total_frames):
    windows = []
    previous_cut = 0
    for number, boundary in enumerate(boundaries):
        cut, pause_start = boundary["frame"], boundary["pauseStartFrame"]
        if type(cut) is not int or type(pause_start) is not int or not (previous_cut <= pause_start <= cut < total_frames):
            raise ValueError("Position de reprise vidéo invalide.")
        next_cut = boundaries[number + 1]["frame"] if number + 1 < len(boundaries) else total_frames
        next_pause = boundaries[number + 1]["pauseStartFrame"] if number + 1 < len(boundaries) else total_frames
        start = max(pause_start, cut - round(fps / 6))
        next_start = max(next_pause, next_cut - round(fps / 6)) if number + 1 < len(boundaries) else total_frames
        end = min(cut + round(1.1 * fps), next_start - 1, total_frames - 1)
        before = [max(previous_cut, cut - round(seconds * fps)) for seconds in (.5, .25, .0625)]
        after = [min(next_cut - 1, cut + round(seconds * fps)) for seconds in (40 / 48, 1, 56 / 48)]
        if end > cut:
            last_key = cut + (end - cut) // 3 * 3
            read_end = max(max(after), min(last_key + 3, next_cut - 1))
            windows.append({"cut": cut, "start": start, "end": end, "before_indices": before,
                            "after_indices": after, "read_end": read_end, "next_end": next_cut - 1, "fps": fps})
        previous_cut = cut
    return windows


def refine_window(frames, window, style):
    if style not in ("interpolated", "reconstructed"):
        raise ValueError("Style de transition inconnu.")
    cut, fps = window["cut"], window["fps"]
    context = dict(window,
                   before=np.median([background_profile(frames[index]) for index in window["before_indices"]], axis=0),
                   after=np.median([background_profile(frames[index]) for index in window["after_indices"]], axis=0))
    interpolated = {}
    for first in range(cut, window["end"] + 1, 3):
        following = min(first + 3, window["next_end"])
        motion = Motion(frames[first], frames[following])
        interpolated[first] = frames[first]
        for offset in (1, 2):
            if first + offset <= following:
                interpolated[first + offset] = motion.blend(offset / max(1, following - first))
    anchor = frames[cut - 1]
    stable_start = max(window["start"], cut - round(.125 * fps))
    stable_end = min(cut + round(.375 * fps), window["end"])
    reconstruction = Motion(frames[stable_start], frames[stable_end]) if style == "reconstructed" else None
    changed = {}
    for index in range(window["start"], window["end"] + 1):
        current = interpolated.get(index, frames[index])
        if reconstruction is not None and stable_start <= index <= stable_end:
            current = reconstruction.blend(smoothstep((index - stable_start) / max(1, stable_end - stable_start)))
        if style == "interpolated" and cut <= index < cut + .30 * fps:
            current = Motion(anchor, current).blend(smoothstep((index - cut) / (.30 * fps)))
        changed[index] = lighting(current, context, index)
    return changed
