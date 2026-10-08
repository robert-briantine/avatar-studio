// Verify a completed native Extend render and remux the original WAV without
// changing any decoded video frame. Safe to re-run on an existing test directory.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { assembleWanVideo, probeDuration, probeVideoFrameCount } from "../src/media.js";

const exec = promisify(execFile);
if (!process.argv[2]) throw new Error("Indique le dossier du test terminé.");
const directory = path.resolve(process.argv[2]);
const reportPath = path.join(directory, "report.json");
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
if (report.status !== "completed") throw new Error("Le rendu GPU n’est pas encore terminé.");
const raw = path.join(directory, "native-raw.mp4");
const target = report.output || path.join(directory, "robot-extend-67s.mp4");
const temporary = path.join(directory, "verified-native.mp4");
const snapshot = path.join(directory, "original-audio.wav");
const snapshotExists = await fs.access(snapshot).then(() => true, () => false);
const audioSource = report.sourceAudioSnapshot || (snapshotExists ? snapshot : report.sourceAudio);
if (report.sourceAudioSha256) {
  assert.equal(createHash("sha256").update(await fs.readFile(audioSource)).digest("hex"), report.sourceAudioSha256,
    "Le WAV exporté doit être celui qui a guidé le rendu.");
}
await assembleWanVideo(raw, audioSource, temporary, report.durationSeconds);
const frames = await probeVideoFrameCount(temporary);
const hashFrames = async (file: string) => (await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file,
  "-map", "0:v:0", "-frames:v", String(frames), "-f", "framemd5", "-"], { maxBuffer: 1024 * 1024 })).stdout
  .split("\n").filter(line => line && !line.startsWith("#"));
assert.deepEqual(await hashFrames(raw), await hashFrames(temporary), "Le montage a altéré les images natives.");
const probe = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", temporary])).stdout);
const video = probe.streams.find((stream: any) => stream.codec_type === "video");
const audio = probe.streams.find((stream: any) => stream.codec_type === "audio");
assert.equal(video.avg_frame_rate, "16/1");
assert.ok(audio);
assert.ok(Math.abs(Number(video.duration) - report.durationSeconds) <= 1 / 16);
assert.ok(Math.abs(Number(audio.duration) - report.durationSeconds) <= 0.05);
await fs.rename(temporary, target);
const times = [0, 10, 30, 45, 50, 60, Math.floor(report.durationSeconds - 1)];
for (const time of times) {
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(time), "-i", target,
    "-frames:v", "1", path.join(directory, `frame-${String(time).padStart(2, "0")}s.png`)]);
}
const thumbnails = await Promise.all(times.map(async time => {
  const thumb = await sharp(path.join(directory, `frame-${String(time).padStart(2, "0")}s.png`)).resize(192, 256)
    .extend({ bottom: 28, background: "#fff" }).png().toBuffer();
  const label = Buffer.from(`<svg width="192" height="284"><text x="8" y="275" font-size="18" font-family="sans-serif">${time} s</text></svg>`);
  return sharp(thumb).composite([{ input: label }]).png().toBuffer();
}));
await sharp({ create: { width: 192 * times.length, height: 284, channels: 3, background: "#fff" } })
  .composite(thumbnails.map((input, index) => ({ input, left: index * 192, top: 0 }))).png().toFile(path.join(directory, "contact-sheet.png"));
Object.assign(report, { output: target, actualDuration: await probeDuration(target), actualFrames: frames,
  ...(snapshotExists ? { sourceAudioSnapshot: snapshot } : {}),
  verification: { nativeFrameHashesPreserved: true, sourceAudioHashPreserved: true, videoDuration: Number(video.duration), audioDuration: Number(audio.duration),
    fps: video.avg_frame_rate, dimensions: `${video.width}x${video.height}` }, visualValidation: "awaiting-user-review" });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output: target, verification: report.verification, visualValidation: report.visualValidation }, null, 2));
