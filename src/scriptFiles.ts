import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AvatarScript } from "./avatarScript.js";
import type { VoiceAsset } from "./avatarStore.js";
import { getScriptTimings, type TimedScriptOverlay } from "./scriptOverlays.js";
import {
  concatVideoOnly, concatWavs, createScriptVideoBlock, extractAudioSegment,
  extractScriptFileAudio, muxVideoAudio, probeLocalVideo
} from "./media.js";

export type ScriptLocalFile = { path: string } & (
  | { kind: "image" }
  | { kind: "video"; duration: number; hasAudio: boolean; videoStreamIndex: number }
);

export async function resolveScriptFiles(script: AvatarScript, signal?: AbortSignal): Promise<Map<string, ScriptLocalFile>> {
  const files = new Map<string, ScriptLocalFile>();
  for (const sequence of script.sequences) {
    signal?.throwIfAborted();
    if (sequence.mode !== "file" || files.has(sequence.content)) continue;
    const content = sequence.content;
    let filePath: string;
    try {
      filePath = await fs.realpath(path.resolve(content));
      if (!(await fs.stat(filePath)).isFile()) throw new Error("not a regular file");
      await fs.access(filePath, fs.constants.R_OK);
    } catch {
      throw new RangeError(`Fichier local absent ou inaccessible : ${content}`);
    }
    let metadata: sharp.Metadata | undefined;
    try { metadata = await sharp(filePath).metadata(); } catch { /* Try a video container. */ }
    if (metadata) {
      if (!metadata.format || !["jpeg", "png", "webp", "gif", "tiff", "avif", "heif", "magick"].includes(metadata.format)
        || (metadata.pages || 1) > 1) throw new RangeError(`Format d’image non pris en charge ou image animée : ${content}`);
      try { await sharp(filePath).stats(); } catch { throw new RangeError(`Image locale illisible : ${content}`); }
      files.set(content, { kind: "image", path: filePath });
    } else {
      try {
        files.set(content, { kind: "video", path: filePath, ...await probeLocalVideo(filePath, signal) });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new RangeError(`Fichier illisible ou format vidéo non pris en charge : ${content}`);
      }
    }
  }
  return files;
}

export type ScriptFileSpan = ({ mode: "avatar" } | { mode: "image"; content: string }
  | { mode: "file-image" | "file-video" | "file-sound"; file: ScriptLocalFile }) & {
  start: number;
  end: number;
  narrationStart?: number;
  narrationEnd?: number;
};

export type ScriptFilePlan = { spans: ScriptFileSpan[]; overlays: TimedScriptOverlay[]; duration: number };

/** File sound inserts playback time; the associated words follow on the avatar. */
export async function planScriptFiles(voice: VoiceAsset, signal?: AbortSignal): Promise<ScriptFilePlan | undefined> {
  if (!voice.script?.sequences.some(sequence => sequence.mode === "file")) return undefined;
  const timings = getScriptTimings(voice);
  const files = await resolveScriptFiles(voice.script, signal);
  const spans: ScriptFileSpan[] = [];
  const overlays: TimedScriptOverlay[] = [];
  let cursor = 0;
  const append = (span: ScriptFileSpan) => {
    const previous = spans.at(-1);
    if (span.mode === "avatar" && previous?.mode === "avatar" && previous.narrationEnd === span.narrationStart) {
      previous.end = span.end;
      previous.narrationEnd = span.narrationEnd;
    } else spans.push(span);
  };
  for (const timing of timings) {
    const sequence = voice.script.sequences[timing.sequenceIndex];
    const duration = timing.end - timing.start;
    if (sequence.mode === "file") {
      const file = files.get(sequence.content)!;
      if (file.kind === "video" && file.hasAudio) {
        append({ mode: "file-sound", file, start: cursor, end: cursor + file.duration });
        cursor += file.duration;
        append({ mode: "avatar", start: cursor, end: cursor + duration, narrationStart: timing.start, narrationEnd: timing.end });
      } else {
        append({ mode: file.kind === "image" ? "file-image" : "file-video", file,
          start: cursor, end: cursor + duration, narrationStart: timing.start, narrationEnd: timing.end });
      }
    } else {
      if (sequence.mode === "text" || sequence.mode === "latex") {
        overlays.push({ mode: sequence.mode, content: sequence.content, start: cursor, end: cursor + duration });
      }
      append(sequence.mode === "image"
        ? { mode: "image", content: sequence.content, start: cursor, end: cursor + duration, narrationStart: timing.start, narrationEnd: timing.end }
        : { mode: "avatar", start: cursor, end: cursor + duration, narrationStart: timing.start, narrationEnd: timing.end });
    }
    cursor += duration;
  }
  return { spans, overlays, duration: cursor };
}

export async function renderScriptFiles(options: {
  plan: ScriptFilePlan;
  audioPath: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  resolveImage: (content: string) => Promise<string>;
  renderAvatar: (audioPath: string, outputPath: string, duration: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const { plan, audioPath, outputPath, width, height, fps, signal } = options;
  const directory = await fs.mkdtemp(path.join(path.dirname(outputPath), ".script-files-"));
  try {
    const images = new Map<string, string>();
    for (const span of plan.spans) {
      signal?.throwIfAborted();
      if (span.mode === "image" && !images.has(span.content)) images.set(span.content, await options.resolveImage(span.content));
    }
    const clips: string[] = [];
    const audioParts: string[] = [];
    for (const [index, span] of plan.spans.entries()) {
      signal?.throwIfAborted();
      const wav = path.join(directory, `${index}.wav`);
      if (span.mode === "file-sound") {
        await extractScriptFileAudio(span.file.path, wav, span.end - span.start, signal);
      } else {
        await extractAudioSegment(audioPath, wav, span.narrationStart!, span.narrationEnd! - span.narrationStart!, signal);
      }
      audioParts.push(wav);
      const frames = Math.ceil(span.end * fps - 1e-8) - Math.ceil(span.start * fps - 1e-8);
      if (frames <= 0) continue;
      const clip = path.join(directory, `${index}.mp4`);
      if (span.mode === "avatar") {
        const raw = path.join(directory, `${index}-avatar.mp4`);
        await options.renderAvatar(wav, raw, span.narrationEnd! - span.narrationStart!);
        await createScriptVideoBlock(raw, clip, width, height, fps, frames, false, signal);
      } else if (span.mode === "image") {
        await createScriptVideoBlock(images.get(span.content)!, clip, width, height, fps, frames, true, signal);
      } else if (span.mode === "file-image") {
        const normalized = path.join(directory, `${index}-image.png`);
        await sharp(span.file.path).rotate().flatten({ background: "black" }).png().toFile(normalized);
        await createScriptVideoBlock(normalized, clip, width, height, fps, frames, true, signal);
      } else {
        await createScriptVideoBlock(span.file.path, clip, width, height, fps, frames, false, signal,
          span.file.kind === "video" ? span.file.videoStreamIndex : undefined);
      }
      clips.push(clip);
    }
    const joined = path.join(directory, "joined.mp4");
    const master = path.join(directory, "master.wav");
    await concatVideoOnly(clips, joined, signal, fps, true);
    await concatWavs(audioParts, master, signal, 2);
    const target = path.join(directory, "result.mp4");
    await muxVideoAudio(joined, master, target, plan.duration, signal);
    signal?.throwIfAborted();
    await fs.rename(target, outputPath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
