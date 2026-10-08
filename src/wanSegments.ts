import fs from "node:fs/promises";
import path from "node:path";
import { buildWanS2VExtendedWorkflow, WAN_S2V_FPS } from "./wanS2V.js";
import { concatVideoOnly, extractFirstVideoFrame, extractLastVideoFrame, extractWanPause, fitWanTransition, matchWanLighting, muxVideoAudio, refineWanTransitions, trimVideoFrames } from "./media.js";
import type { PromptGraph } from "./workflows.js";
import { parseWanTransitionStyle, type WanTransitionStyle } from "./wanTransitions.js";

export type NarrationSegment = { path: string; duration: number; speechDuration?: number; tailSilenceSeconds?: number };
export type SegmentProgress = { phase: "blocks" | "transitions" | "assembly"; index: number; total: number; progress: number; message: string };
export const WAN_SEGMENT_FPS = WAN_S2V_FPS * 3;

export function planNarrationFrames(segments: NarrationSegment[]) {
  let duration = 0;
  let previousEnd = 0;
  return segments.map((segment, index) => {
    if (!Number.isFinite(segment.duration) || segment.duration <= 0) throw new Error("Durée de morceau invalide.");
    duration += segment.duration;
    // Round cumulative boundaries, avoiding a rounding error per piece.
    const end = Math.max(previousEnd + 1, Math.round(duration * WAN_SEGMENT_FPS));
    const frames = end - previousEnd;
    const speechSeconds = segment.speechDuration ?? Math.max(0, segment.duration - (segment.tailSilenceSeconds ?? 0));
    const speechFrames = Math.min(frames, Math.ceil(speechSeconds * WAN_SEGMENT_FPS));
    const pauseFrames = frames - speechFrames;
    const hasNext = index + 1 < segments.length;
    // Give S2V time to close the mouth before taking the outgoing frame.
    const minimumTransitionFrames = 3 * WAN_SEGMENT_FPS / WAN_S2V_FPS;
    const settlingFrames = hasNext && pauseFrames >= minimumTransitionFrames
      ? Math.min(WAN_SEGMENT_FPS / 4, pauseFrames - minimumTransitionFrames) : 0;
    const transitionFrames = hasNext && pauseFrames >= minimumTransitionFrames ? pauseFrames - settlingFrames : 0;
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
  transitionStyle?: WanTransitionStyle;
  filenamePrefix: string;
  uploadAudio: (localPath: string, index: number) => Promise<string>;
  uploadImage: (localPath: string) => Promise<string>;
  render: (graph: PromptGraph, outputPath: string) => Promise<void>;
  onProgress?: (event: SegmentProgress) => Promise<void>;
  signal?: AbortSignal;
}) {
  if (!args.segments.length) throw new Error("Aucun morceau à générer.");
  const transitionStyle = parseWanTransitionStyle(args.transitionStyle);
  await fs.mkdir(args.workDir, { recursive: true });
  const plan = planNarrationFrames(args.segments);
  const blocks: Array<{ source: string; visual: string; first: string; last: string; pauseStart: string; endImageName: string }> = [];
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
    let source = raw;
    if (index > 0) {
      // S2V's VAE can crush the first frame's shadows despite exact conditioning.
      // Match just the first 500 ms; keep speech motion and the remaining clip.
      source = path.join(args.workDir, `block-${index + 1}-handoff.mp4`);
      await matchWanLighting(raw, source, blocks[index - 1].last, undefined, args.signal);
    }
    const complete = path.join(args.workDir, `block-${index + 1}-complete.mp4`);
    await trimVideoFrames(source, complete, plan[index].frames, args.signal, WAN_SEGMENT_FPS);
    const visual = path.join(args.workDir, `block-${index + 1}.mp4`);
    await trimVideoFrames(complete, visual, plan[index].keepFrames, args.signal, WAN_SEGMENT_FPS);
    const first = path.join(args.workDir, `block-${index + 1}-first.png`);
    const last = path.join(args.workDir, `block-${index + 1}-last.png`);
    const pauseStart = path.join(args.workDir, `block-${index + 1}-pause-start.png`);
    await extractFirstVideoFrame(complete, first, args.signal);
    // Condition the next S2V block on the end of the actual pause, so movement
    // does not return to an earlier pose when the next sentence starts.
    await extractLastVideoFrame(complete, last, args.signal);
    await extractLastVideoFrame(visual, pauseStart, args.signal);
    const endImageName = await args.uploadImage(last);
    blocks.push({ source, visual, first, last, pauseStart, endImageName });
    controlImageName = endImageName;
  }

  // Pass 2: join the actual files from pass 1, never a different render.
  const parts: string[] = [];
  const transitions: Array<{ from: number; to: number; start: string; end: string; frames: number; path: string; method: "s2v-pause" }> = [];
  for (let index = 0; index < blocks.length; index++) {
    parts.push(blocks[index].visual);
    const frames = plan[index].transitionFrames;
    if (!frames) continue;
    const next = blocks[index + 1];
    await args.onProgress?.({ phase: "transitions", index, total: blocks.length - 1,
      progress: 65 + index / Math.max(1, blocks.length - 1) * 27,
      message: `Mouvement naturel : raccord ${index + 1} → ${index + 2}…` });
    const raw = path.join(args.workDir, `transition-${index + 1}-raw.mp4`);
    await extractWanPause(blocks[index].source, raw, plan[index].keepFrames, frames, args.signal, WAN_SEGMENT_FPS);
    const fitted = path.join(args.workDir, `transition-${index + 1}.mp4`);
    await fitWanTransition(raw, fitted, frames, blocks[index].pauseStart, next.first, args.signal, WAN_SEGMENT_FPS);
    parts.push(fitted);
    transitions.push({ from: index, to: index + 1, start: blocks[index].pauseStart, end: next.first, frames, path: fitted, method: "s2v-pause" });
  }
  await args.onProgress?.({ phase: "assembly", index: blocks.length, total: blocks.length, progress: 95,
    message: "Assemblage des morceaux et des raccords avec le WAV original…" });
  const visual = path.join(args.workDir, "assembled-visual.mp4");
  await concatVideoOnly(parts, visual, args.signal, WAN_SEGMENT_FPS);
  let finalVisual = visual;
  if (plan.length > 1) {
    await args.onProgress?.({ phase: "assembly", index: blocks.length, total: blocks.length, progress: 97,
      message: transitionStyle === "reconstructed" ? "Transition 4 : reprise reconstruite…" : "Transition 3 : mouvement interpolé…" });
    finalVisual = path.join(args.workDir, "refined-visual.mp4");
    await refineWanTransitions(visual, finalVisual, plan.slice(0, -1).map(block => ({
      frame: block.startFrame + block.frames, pauseStartFrame: block.startFrame + block.keepFrames
    })), transitionStyle, args.signal);
  }
  const totalDuration = args.segments.reduce((sum, segment) => sum + segment.duration, 0);
  const duration = await muxVideoAudio(finalVisual, args.audioPath, args.outputPath, totalDuration, args.signal);
  const report = { duration, fps: WAN_SEGMENT_FPS, transitionStyle, outputPath: args.outputPath, plan, blocks, transitions };
  await fs.writeFile(path.join(args.workDir, "manifest.json"), JSON.stringify(report, null, 2));
  return report;
}
