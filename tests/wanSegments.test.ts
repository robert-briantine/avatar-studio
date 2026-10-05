import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { concatWavs, createSilence, extractLastVideoFrame, probeVideoFrameCount } from "../src/media.js";
import { buildWanFirstLastFrameWorkflow } from "../src/wanFLF.js";
import { renderWanSegments } from "../src/wanSegments.js";

const exec = promisify(execFile);

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

test("three retained blocks have two FLF joins using their exact boundaries and one continuous audio master", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wan-chain-"));
  const uploads = new Map<string, string>();
  const calls: string[] = [];
  const colours = ["red", "blue", "green"];
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
        const bridge = Object.values(graph).find(node => node.class_type === "WanFirstLastFrameToVideo");
        if (initial) {
          const index = calls.length;
          assert.ok(index < 3, "a block was regenerated after transitions started");
          const control = graph[(initial.inputs.control_video as [string, number])[0]].inputs.image;
          assert.equal(control, index ? `block-${index}-last.png` : "reference.png");
          calls.push("block");
          await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${colours[index]}:s=64x64:r=16:d=2`, "-c:v", "libx264", target]);
        } else {
          assert.ok(bridge);
          const index = calls.length - 3;
          const start = graph[(bridge.inputs.start_image as [string, number])[0]].inputs.image as string;
          const end = graph[(bridge.inputs.end_image as [string, number])[0]].inputs.image as string;
          assert.equal(uploads.get(start), path.join(dir, `block-${index + 1}-last.png`));
          assert.equal(uploads.get(end), path.join(dir, `block-${index + 2}-first.png`));
          assert.equal((Number(bridge.inputs.length) - 1) % 4, 0);
          calls.push("transition");
          await exec("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=16", "-frames:v", String(bridge.inputs.length), "-c:v", "libx264", target]);
        }
      }
    });
    assert.deepEqual(calls, ["block", "block", "block", "transition", "transition"]);
    assert.equal(report.transitions.length, 2, "there must be no final transition back to the reference");
    const counts = await Promise.all([...report.blocks.map(block => block.visual), ...report.transitions.map(bridge => bridge.path), path.join(dir, "assembled-visual.mp4")].map(file => probeVideoFrameCount(file)));
    const details = await Promise.all([audio, path.join(dir, "assembled-visual.mp4"), report.outputPath].map(file => exec("ffprobe", ["-v", "error", "-show_entries", "stream=start_time,duration,nb_frames,avg_frame_rate", "-of", "json", file])));
    assert.equal(await probeVideoFrameCount(report.outputPath), Math.round(3.93 * 16), `part frame counts: ${counts}; details: ${details.map(detail => detail.stdout).join(" ")}`);
    for (let index = 0; index < report.transitions.length; index++) {
      const transition = report.transitions[index];
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

test("all short FLF durations preserve the end-image temporal slot", () => {
  for (const durationSeconds of [0.2, 0.4, 0.8, 1.1, 1.6, 3]) {
    const { frames } = buildWanFirstLastFrameWorkflow({ startImageName: "a", endImageName: "b", prompt: "", width: 512, height: 288, durationSeconds, seed: 1 });
    assert.equal((frames - 1) % 4, 0);
  }
});
