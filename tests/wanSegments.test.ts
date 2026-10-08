import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { concatWavs, createSilence, extractLastVideoFrame, extractWanPause, fitWanTransition, probeVideoFrameCount } from "../src/media.js";
import { buildWanFirstLastFrameWorkflow, WAN_FLF_FPS } from "../src/wanFLF.js";
import { planNarrationFrames, renderWanSegments, WAN_SEGMENT_FPS } from "../src/wanSegments.js";

const exec = promisify(execFile);

test("the default pause has more transition images without moving speech boundaries", () => {
  const segments = Array.from({ length: 3 }, () => ({ path: "unused.wav", duration: 1.8, speechDuration: 1, tailSilenceSeconds: 0.8 }));
  const plan = planNarrationFrames(segments);
  assert.equal(plan[0].transitionFrames, 26);
  assert.equal(plan.at(-1)!.transitionFrames, 0);
  assert.equal(plan.reduce((sum, block) => sum + block.frames, 0), Math.round(5.4 * WAN_SEGMENT_FPS));
  for (let index = 0; index < plan.length; index++) {
    assert.ok(plan[index].keepFrames >= Math.ceil(segments[index].speechDuration * WAN_SEGMENT_FPS));
    assert.ok(Math.abs(plan[index].startFrame / WAN_SEGMENT_FPS - index * 1.8) <= 0.5 / WAN_SEGMENT_FPS);
  }
  for (const pause of [0, 0.1, 0.2, 0.8, 3]) {
    const [block] = planNarrationFrames([{ path: "", duration: 1 + pause, speechDuration: 1 }, segments[0]]);
    assert.equal(block.frames, block.keepFrames + block.transitionFrames);
    assert.ok(block.keepFrames >= WAN_SEGMENT_FPS, "a short pause must not trim spoken frames");
  }
});

test("the outgoing image is the last decoded frame, even with a longer audio track", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wan-last-frame-"));
  try {
    const movie = path.join(dir, "last-red.mp4");
    await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=16:d=0.9375",
      "-f", "lavfi", "-i", "color=c=red:s=64x64:r=16:d=0.0625", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=2",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
      "-c:v", "libx264", "-c:a", "aac", movie]);
    const last = path.join(dir, "last.png");
    await extractLastVideoFrame(movie, last);
    const stats = await sharp(last).stats();
    assert.ok(stats.channels[0].mean > 240, "expected the red frame at the end of video, not an earlier blue frame");
    assert.ok(stats.channels[2].mean < 10);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a stereo pause appended to mono TTS keeps the requested duration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wan-pause-"));
  try {
    const speech = path.join(dir, "mono.wav");
    const silence = path.join(dir, "stereo.wav");
    await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=1", "-c:a", "pcm_s16le", speech]);
    await createSilence(silence, 0.7);
    const duration = await concatWavs([speech, silence], path.join(dir, "combined.wav"));
    assert.ok(Math.abs(duration - 1.7) < 0.001, `the pause was changed: duration=${duration}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("three retained blocks use their actual silent pauses and final poses with one continuous audio master", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wan-chain-"));
  const uploads = new Map<string, string>();
  const calls: string[] = [];
  const colours = ["red", "blue", "green"];
  const tailColours = ["yellow", "cyan", "gray"];
  try {
    const audio = path.join(dir, "master.wav");
    await createSilence(audio, 3.93);
    const report = await renderWanSegments({
      segments: Array.from({ length: 3 }, () => ({ path: audio, duration: 1.31, speechDuration: 0.31 })),
      referenceImageName: "reference.png", audioPath: audio, outputPath: path.join(dir, "final.mp4"), workDir: dir,
      prompt: "test", strictIdentity: true, seed: 1, width: 64, height: 64, steps: 12, cfg: 5.5, filenamePrefix: "test",
      uploadAudio: async (_, index) => `audio-${index}.wav`,
      uploadImage: async file => { const name = path.basename(file); uploads.set(name, file); return name; },
      render: async (graph, target) => {
        const initial = Object.values(graph).find(node => node.class_type === "WanSoundImageToVideo");
        assert.ok(!Object.values(graph).some(node => node.class_type === "WanFirstLastFrameToVideo"), "a separate model must not invent a different head movement during the pause");
        assert.ok(initial);
        const index = calls.length;
        assert.ok(index < 3, "a block was regenerated after transitions started");
        const control = graph[(initial.inputs.control_video as [string, number])[0]].inputs.image;
        assert.equal(control, index ? `block-${index}-last.png` : "reference.png");
        calls.push("block");
        await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${colours[index]}:s=64x64:r=16:d=2`,
          "-vf", `drawbox=color=${tailColours[index]}:t=fill:enable='gte(t,1.1)'`, "-c:v", "libx264", target]);
      }
    });
    assert.deepEqual(calls, ["block", "block", "block"]);
    const controlPose = await sharp(report.blocks[0].last).stats();
    const pauseStart = await sharp(report.blocks[0].pauseStart).stats();
    assert.ok(controlPose.channels[1].mean > 240, "the next block must start from the actual end of the yellow pause");
    assert.ok(pauseStart.channels[1].mean < 20, "the red speech boundary and the yellow final pose must remain distinct");
    assert.equal(uploads.get(report.blocks[0].endImageName), report.blocks[0].last);
    assert.equal(report.transitions.length, 2, "there must be no final transition back to the reference");
    const counts = await Promise.all([...report.blocks.map(block => block.visual), ...report.transitions.map(bridge => bridge.path), path.join(dir, "assembled-visual.mp4")].map(file => probeVideoFrameCount(file)));
    const details = await Promise.all([audio, path.join(dir, "assembled-visual.mp4"), report.outputPath].map(file => exec("ffprobe", ["-v", "error", "-show_entries", "stream=start_time,duration,nb_frames,avg_frame_rate", "-of", "json", file])));
    assert.equal(report.fps, WAN_SEGMENT_FPS);
    assert.equal(report.transitionStyle, "interpolated");
    assert.equal(await probeVideoFrameCount(report.outputPath), Math.round(3.93 * WAN_SEGMENT_FPS), `part frame counts: ${counts}; details: ${details.map(detail => detail.stdout).join(" ")}`);
    const streams = JSON.parse(details[2].stdout).streams;
    assert.equal(streams[0].avg_frame_rate, `${WAN_SEGMENT_FPS}/1`);
    assert.ok(streams.every((stream: { duration: string }) => Math.abs(Number(stream.duration) - 3.93) < 1 / WAN_SEGMENT_FPS));
    for (let index = 0; index < report.transitions.length; index++) {
      const transition = report.transitions[index];
      assert.equal(transition.method, "s2v-pause");
      assert.equal(await probeVideoFrameCount(transition.path), transition.frames);
      const end = path.join(dir, `transition-${index}-end.png`);
      await extractLastVideoFrame(transition.path, end);
      const actual = await sharp(end).raw().toBuffer();
      const expected = await sharp(transition.end).raw().toBuffer();
      const error = actual.reduce((sum, value, offset) => sum + Math.abs(value - expected[offset]), 0) / actual.length;
      assert.ok(error < 3, `arrival frame doesn't match the following block: ${error}`);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("pause interpolation adds distinct motion images while preserving the native movement and time range", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wan-native-pause-"));
  try {
    const raw = path.join(dir, "native.mp4"), output = path.join(dir, "pause.mp4");
    await exec("ffmpeg", ["-y", "-f", "lavfi", "-i",
      "nullsrc=s=128x64:r=16,geq=lum='if(between(X,12+2*N,24+2*N)*between(Y,20,44),220,30)':cb=128:cr=128",
      "-frames:v", "32", "-c:v", "libx264", "-crf", "0", raw]);
    await extractWanPause(raw, output, 24, 27);
    assert.equal(await probeVideoFrameCount(output), 27);
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", output, "-an", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { encoding: "buffer" });
    const centers = Array.from({ length: 27 }, (_, frame) => {
      const pixels = stdout.subarray(frame * 128 * 64, (frame + 1) * 128 * 64);
      let weight = 0, position = 0;
      pixels.forEach((value, index) => { const w = Math.max(0, value - 60); weight += w; position += w * (index % 128); });
      return position / weight;
    });
    assert.ok(Math.abs(centers[0] - 34) < 2, `the pause starts at the wrong instant: ${centers[0]}`);
    assert.ok(Math.abs(centers.at(-1)! - (34 + 26 / 48 * 32)) < 2, `the pause ends at the wrong instant: ${centers.at(-1)}`);
    assert.ok(new Set(centers.map(value => value.toFixed(2))).size >= 20, "extra motion frames must not be duplicates");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("all short FLF durations preserve the end-image temporal slot", () => {
  for (const durationSeconds of [0.2, 0.4, 0.8, 1.1, 1.6, 3]) {
    const { frames } = buildWanFirstLastFrameWorkflow({ startImageName: "a", endImageName: "b", prompt: "", width: 512, height: 288, durationSeconds, seed: 1 });
    assert.equal((frames - 1) % 4, 0);
    assert.ok(frames >= Math.round(durationSeconds * WAN_FLF_FPS));
  }
});

test("fitting a transition preserves distinct intermediate frames and eases VAE boundary differences", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wan-detailed-join-"));
  try {
    const raw = path.join(dir, "raw.mp4"), fitted = path.join(dir, "fitted.mp4");
    const start = path.join(dir, "start.png"), end = path.join(dir, "end.png");
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toFile(start);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 230, g: 230, b: 230 } } }).png().toFile(end);
    await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", `nullsrc=s=64x64:r=${WAN_FLF_FPS},geq=lum='70+4*N':cb=128:cr=128`,
      "-frames:v", "29", "-c:v", "libx264", "-crf", "0", raw]);
    const frames = 27;
    await fitWanTransition(raw, fitted, frames, start, end, undefined, WAN_FLF_FPS);
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", fitted, "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
    const bytes = 64 * 64 * 3;
    assert.equal(stdout.length, frames * bytes);
    const means = Array.from({ length: frames }, (_, index) => {
      const pixels = stdout.subarray(index * bytes, (index + 1) * bytes);
      return pixels.reduce((sum, value) => sum + value, 0) / bytes;
    });
    assert.ok(Math.abs(means[0] - 20) < 3);
    assert.ok(Math.abs(means.at(-1)! - 230) < 3);
    assert.equal(new Set(means.map(value => Math.round(value))).size, frames, "the extra images must not be duplicated");
    assert.ok(Math.max(...means.slice(1).map((value, index) => Math.abs(value - means[index]))) < 35,
      `an abrupt endpoint replacement remains: ${means}`);
    for (const frames of [3, 6]) {
      const short = path.join(dir, `short-${frames}.mp4`);
      await fitWanTransition(raw, short, frames, start, end, undefined, WAN_FLF_FPS);
      assert.equal(await probeVideoFrameCount(short), frames);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
