import fs from "node:fs/promises";
import path from "node:path";
import { buildWanS2VExtendedWorkflow, WAN_S2V_FPS } from "./wanS2V.js";
import { buildWanFirstLastFrameWorkflow } from "./wanFLF.js";
import { concatVideoOnly, extractFirstVideoFrame, extractLastVideoFrame, fitWanTransition, muxVideoAudio, trimVideoFrames } from "./media.js";
import type { PromptGraph } from "./workflows.js";

export type NarrationSegment = { path: string; duration: number; speechDuration?: number; tailSilenceSeconds?: number };
export type SegmentProgress = { phase: "blocks" | "transitions" | "assembly"; index: number; total: number; progress: number; message: string };

export function planNarrationFrames(segments: NarrationSegment[]) {
  let duration = 0;
  let previousEnd = 0;
  return segments.map((segment, index) => {
    if (!Number.isFinite(segment.duration) || segment.duration <= 0) throw new Error("Durée de morceau invalide.");
    duration += segment.duration;
    // Round cumulative boundaries, avoiding a rounding error per piece.
    const end = Math.max(previousEnd + 1, Math.round(duration * WAN_S2V_FPS));
    const frames = end - previousEnd;
    const speechSeconds = segment.speechDuration ?? Math.max(0, segment.duration - (segment.tailSilenceSeconds ?? 0));
    const speechFrames = Math.min(frames, Math.ceil(speechSeconds * WAN_S2V_FPS));
    const pauseFrames = frames - speechFrames;
    const hasNext = index + 1 < segments.length;
    // Give S2V time to close the mouth before taking the outgoing frame.
    const settlingFrames = hasNext && pauseFrames >= 3 ? Math.min(4, pauseFrames - 3) : 0;
    const transitionFrames = hasNext && pauseFrames >= 3 ? pauseFrames - settlingFrames : 0;
    const startFrame = previousEnd;
    previousEnd = end;
    return { startFrame, frames, keepFrames: frames - transitionFrames, transitionFrames };
  });
}

/** Each S2V result is generated once, retained, and used at both sides of its junctions. */
export async function renderWanSegments(args: {
  segments: NarrationSegment[];
  referenceImageName: string;
  audioPath: string;
  outputPath: string;
  workDir: string;
  prompt: string;
  strictIdentity: boolean;
  seed: number;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  chunkFrames?: number;
  filenamePrefix: string;
  uploadAudio: (localPath: string, index: number) => Promise<string>;
  uploadImage: (localPath: string) => Promise<string>;
  render: (graph: PromptGraph, outputPath: string) => Promise<void>;
  onProgress?: (event: SegmentProgress) => Promise<void>;
  signal?: AbortSignal;
}) {
  if (!args.segments.length) throw new Error("Aucun morceau à générer.");
  await fs.mkdir(args.workDir, { recursive: true });
  const plan = planNarrationFrames(args.segments);
  const blocks: Array<{ visual: string; first: string; last: string; startImageName: string; endImageName: string }> = [];
  let controlImageName = args.referenceImageName;

  // Pass 1: carry only the exact outgoing image into a fresh S2V graph.
  // There is no speculative lookahead and no regeneration of a stored block.
  for (let index = 0; index < args.segments.length; index++) {
    args.signal?.throwIfAborted();
    const segment = args.segments[index];
    await args.onProgress?.({ phase: "blocks", index, total: args.segments.length,
      progress: 8 + index / args.segments.length * 57,
      message: `Wan2.2 : génération du morceau ${index + 1}/${args.segments.length}…` });
    const audioName = await args.uploadAudio(segment.path, index);
    const { graph } = buildWanS2VExtendedWorkflow({
      imageName: args.referenceImageName, controlImageName, audioName,
      prompt: args.prompt, strictIdentity: args.strictIdentity,
      seed: args.seed + index, width: args.width, height: args.height,
      durationSeconds: segment.duration, steps: args.steps, cfg: args.cfg,
      chunkFrames: args.chunkFrames,
      filenamePrefix: `${args.filenamePrefix}-block-${index + 1}`
    });
    const raw = path.join(args.workDir, `block-${index + 1}-raw.mp4`);
    await args.render(graph, raw);
    const visual = path.join(args.workDir, `block-${index + 1}.mp4`);
    await trimVideoFrames(raw, visual, plan[index].keepFrames, args.signal);
    const first = path.join(args.workDir, `block-${index + 1}-first.png`);
    const last = path.join(args.workDir, `block-${index + 1}-last.png`);
    await extractFirstVideoFrame(visual, first, args.signal);
    await extractLastVideoFrame(visual, last, args.signal);
    const startImageName = await args.uploadImage(first);
    const endImageName = await args.uploadImage(last);
    blocks.push({ visual, first, last, startImageName, endImageName });
    controlImageName = endImageName;
  }

  // Pass 2: join the actual files from pass 1, never a different render.
  const parts: string[] = [];
  const transitions: Array<{ from: number; to: number; start: string; end: string; frames: number; path: string }> = [];
  for (let index = 0; index < blocks.length; index++) {
    parts.push(blocks[index].visual);
    const frames = plan[index].transitionFrames;
    if (!frames) continue;
    const next = blocks[index + 1];
    await args.onProgress?.({ phase: "transitions", index, total: blocks.length - 1,
      progress: 65 + index / Math.max(1, blocks.length - 1) * 27,
      message: `Wan2.2 First/Last Frame : raccord ${index + 1} → ${index + 2}…` });
    const { graph } = buildWanFirstLastFrameWorkflow({
      startImageName: blocks[index].endImageName, endImageName: next.startImageName,
      prompt: "The same person pauses speaking with a relaxed mouth. Subtle natural movement connects the two frames smoothly. Preserve facial identity, clothing, background, lighting and framing. A steady camera, no scene change.",
      width: args.width, height: args.height, durationSeconds: frames / WAN_S2V_FPS,
      seed: args.seed + 10000 + index, steps: 20,
      filenamePrefix: `${args.filenamePrefix}-transition-${index + 1}`
    });
    const raw = path.join(args.workDir, `transition-${index + 1}-raw.mp4`);
    await args.render(graph, raw);
    const fitted = path.join(args.workDir, `transition-${index + 1}.mp4`);
    await fitWanTransition(raw, fitted, frames, blocks[index].last, next.first, args.signal);
    parts.push(fitted);
    transitions.push({ from: index, to: index + 1, start: blocks[index].last, end: next.first, frames, path: fitted });
  }
  await args.onProgress?.({ phase: "assembly", index: blocks.length, total: blocks.length, progress: 95,
    message: "Assemblage des morceaux et des raccords avec le WAV original…" });
  const visual = path.join(args.workDir, "assembled-visual.mp4");
  await concatVideoOnly(parts, visual, args.signal);
  const totalDuration = args.segments.reduce((sum, segment) => sum + segment.duration, 0);
  const duration = await muxVideoAudio(visual, args.audioPath, args.outputPath, totalDuration, args.signal);
  const report = { duration, outputPath: args.outputPath, plan, blocks, transitions };
  await fs.writeFile(path.join(args.workDir, "manifest.json"), JSON.stringify(report, null, 2));
  return report;
}
