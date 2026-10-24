import fs from "node:fs/promises";
import path from "node:path";
import type { VoiceAsset } from "./avatarStore.js";
import { hasScriptImages } from "./avatarScript.js";
import { getScriptTimings } from "./scriptOverlays.js";
import { concatVideoOnly, createScriptVideoBlock, extractAudioSegment, muxVideoAudio } from "./media.js";

export type ScriptVisualSpan = ({ mode: "avatar" } | { mode: "image"; content: string }) & {
  start: number;
  end: number;
};

export function planScriptImages(voice: VoiceAsset): ScriptVisualSpan[] {
  if (!voice.script || !hasScriptImages(voice.script)) return [];
  const spans: ScriptVisualSpan[] = [];
  for (const timing of getScriptTimings(voice)) {
    const sequence = voice.script.sequences[timing.sequenceIndex];
    const previous = spans.at(-1);
    if (sequence.mode !== "image" && previous?.mode === "avatar") {
      previous.end = timing.end;
    } else {
      spans.push(sequence.mode === "image"
        ? { mode: "image", content: sequence.content, start: timing.start, end: timing.end }
        : { mode: "avatar", start: timing.start, end: timing.end });
    }
  }
  return spans;
}

/** Render only visible avatar intervals; retain the original continuous WAV. */
export async function renderScriptImages(options: {
  spans: ScriptVisualSpan[];
  audioPath: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  resolveImage: (content: string) => Promise<string>;
  renderAvatar: (audioPath: string, outputPath: string, duration: number) => Promise<void>;
  onProgress?: (completed: number, total: number) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const { spans, audioPath, outputPath, width, height, fps, signal } = options;
  if (!spans.length) throw new Error("Aucune séquence à monter.");
  const directory = await fs.mkdtemp(path.join(path.dirname(outputPath), ".script-images-"));
  try {
    // Resolve every image before loading Wan, so image/video models do not
    // alternate on the GPU for each paragraph.
    const images = new Map<string, string>();
    for (const span of spans) {
      signal?.throwIfAborted();
      if (span.mode === "image" && !images.has(span.content)) images.set(span.content, await options.resolveImage(span.content));
    }
    const clips: string[] = [];
    for (const [index, span] of spans.entries()) {
      signal?.throwIfAborted();
      const startFrame = Math.ceil(span.start * fps - 1e-8);
      const endFrame = Math.ceil(span.end * fps - 1e-8);
      const frames = endFrame - startFrame;
      if (frames <= 0) continue;
      const clip = path.join(directory, `${index}.mp4`);
      if (span.mode === "image") {
        await createScriptVideoBlock(images.get(span.content)!, clip, width, height, fps, frames, true, signal);
      } else {
        const wav = path.join(directory, `${index}.wav`);
        const raw = path.join(directory, `${index}-avatar.mp4`);
        const duration = await extractAudioSegment(audioPath, wav, span.start, span.end - span.start, signal);
        await options.renderAvatar(wav, raw, duration);
        await createScriptVideoBlock(raw, clip, width, height, fps, frames, false, signal);
      }
      clips.push(clip);
      await options.onProgress?.(index + 1, spans.length);
    }
    const joined = path.join(directory, "joined.mp4");
    await concatVideoOnly(clips, joined, signal, fps, true);
    const target = path.join(directory, "result.mp4");
    await muxVideoAudio(joined, audioPath, target, spans.at(-1)!.end, signal);
    signal?.throwIfAborted();
    await fs.rename(target, outputPath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
