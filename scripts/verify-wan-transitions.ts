import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const directory = process.argv[2];
if (!directory) throw new Error("Indique le dossier du test.");
const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
const { stdout: metadata } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", manifest.outputPath]);
const stream = JSON.parse(metadata).streams[0];
const { stdout: video } = await exec("ffmpeg", ["-v", "error", "-i", manifest.outputPath, "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
const bytes = stream.width * stream.height * 3;
const count = video.length / bytes;
const frame = (index: number) => video.subarray(index * bytes, (index + 1) * bytes);
const difference = (a: number, b: number) => {
  const first = frame(a), second = frame(b);
  let total = 0;
  for (let index = 0; index < bytes; index++) total += Math.abs(first[index] - second[index]);
  return total / bytes;
};
const flatFrames: number[] = [];
for (let index = 0; index < count; index++) {
  const pixels = frame(index);
  let sum = 0, squared = 0;
  for (let offset = 0; offset < bytes; offset += 3) {
    const luma = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
    sum += luma; squared += luma * luma;
  }
  const n = bytes / 3;
  if (Math.sqrt(Math.max(0, squared / n - (sum / n) ** 2)) < 3) flatFrames.push(index);
}
const junctions = manifest.transitions.map((transition: any) => {
  const block = manifest.plan[transition.from];
  const first = block.startFrame + block.keepFrames;
  const end = block.startFrame + block.frames;
  const internal = Array.from({ length: end - first - 1 }, (_, index) => difference(first + index, first + index + 1));
  return { from: transition.from + 1, to: transition.to + 1, firstFrame: first, nextBlockFrame: end,
    startError: difference(first - 1, first), endError: difference(end - 1, end),
    maxInternalStep: Math.max(...internal) };
});
const result = { frames: count, expectedFrames: manifest.plan.reduce((sum: number, block: any) => sum + block.frames, 0), flatFrames, junctions };
await fs.writeFile(path.join(directory, "verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (count !== result.expectedFrames || flatFrames.length || junctions.some((junction: any) => junction.startError > 5 || junction.endError > 5)) {
  throw new Error("Le contrôle du raccord a échoué : voir verification.json.");
}
