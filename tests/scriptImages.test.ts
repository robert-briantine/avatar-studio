import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { VoiceAsset } from "../src/avatarStore.js";
import { parseAvatarScript } from "../src/avatarScript.js";
import { planScriptImages, renderScriptImages } from "../src/scriptImages.js";
import { createScriptVideoBlock, probeDuration, probeVideoFrameCount } from "../src/media.js";

const exec = promisify(execFile);

test("image plans merge visible avatar passages and require measured narration bounds", () => {
  const script = parseAvatarScript("Début. {Texte: titre} Suite. {Image: licorne} Image. {} Fin.");
  const voice: VoiceAsset = { name: "v.wav", path: "unused", url: "", text: script.narration, presetId: "narrator", voicePrompt: "", script, duration: 4,
    scriptTimings: script.sequences.map((_, sequenceIndex) => ({ sequenceIndex, start: sequenceIndex, end: sequenceIndex + 1 })) };
  assert.deepEqual(planScriptImages(voice), [
    { mode: "avatar", start: 0, end: 2 }, { mode: "image", content: "licorne", start: 2, end: 3 }, { mode: "avatar", start: 3, end: 4 }
  ]);
  assert.throws(() => planScriptImages({ ...voice, scriptTimings: undefined }), /Régénère la voix/);
  assert.deepEqual(planScriptImages({ ...voice, script: parseAvatarScript("Bonjour.") }), []);
});

test("images replace the whole frame only during their narration without accumulating frame drift", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-images-montage-"));
  try {
    const image = path.join(directory, "image.png");
    const avatar = path.join(directory, "avatar.png");
    const audio = path.join(directory, "master.wav");
    const output = path.join(directory, "result.mp4");
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#cc2211" } }).png().toFile(image);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#1133cc" } }).png().toFile(avatar);
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1.97", audio]);
    const originalAudio = await readFile(audio);
    const durations: number[] = [];
    let imageRequests = 0;
    await renderScriptImages({
      spans: [
        { mode: "avatar", start: 0, end: 0.27 }, { mode: "image", content: "licorne", start: 0.27, end: 0.86 },
        { mode: "avatar", start: 0.86, end: 1.13 }, { mode: "image", content: "licorne", start: 1.13, end: 1.54 },
        { mode: "avatar", start: 1.54, end: 1.97 }
      ], audioPath: audio, outputPath: output, width: 64, height: 64, fps: 16,
      resolveImage: async () => { imageRequests++; return image; },
      renderAvatar: async (wav, target, duration) => {
        assert.ok(Math.abs(await probeDuration(wav) - duration) < 0.0001);
        durations.push(duration);
        await createScriptVideoBlock(avatar, target, 64, 64, 16, Math.ceil(duration * 16), true);
      }
    });
    assert.equal(imageRequests, 1);
    assert.equal(durations.length, 3, "only visible avatar intervals may reach Wan");
    [0.27, 0.27, 0.43].forEach((duration, index) => assert.ok(Math.abs(durations[index] - duration) < 0.0001));
    assert.equal(await probeVideoFrameCount(output), 32, "round cumulative bounds, not individual durations");
    const { stdout: frames } = await exec("ffmpeg", ["-v", "error", "-i", output, "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
    for (let index = 0; index < 32; index++) {
      const offset = index * 64 * 64 * 3 + (32 * 64 + 32) * 3;
      assert.equal(frames[offset] > frames[offset + 2], (index >= 5 && index < 14) || (index >= 19 && index < 25), `wrong visual at frame ${index}`);
    }
    const probe = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output])).stdout);
    assert.ok(Math.abs(Number(probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio").duration) - 1.97) < 0.03);
    assert.deepEqual(await readFile(audio), originalAudio);
    assert.ok(!(await readdir(directory)).some(name => name.startsWith(".script-images-")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("image-only narration never calls Wan and a generation failure preserves the previous output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-images-only-"));
  try {
    const image = path.join(directory, "image.png");
    const audio = path.join(directory, "master.wav");
    const output = path.join(directory, "result.mp4");
    await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } }).png().toFile(image);
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=0.5", audio]);
    const options = {
      spans: [{ mode: "image" as const, content: "licorne", start: 0, end: 0.5 }],
      audioPath: audio, outputPath: output, width: 64, height: 64, fps: 16,
      resolveImage: async () => image,
      renderAvatar: async () => { assert.fail("an image-only script must not generate avatar video"); }
    };
    await renderScriptImages(options);
    assert.equal(await probeVideoFrameCount(output), 8);
    const original = await readFile(output);
    await assert.rejects(renderScriptImages({ ...options, resolveImage: async () => { throw new Error("image unavailable"); } }), /image unavailable/);
    assert.deepEqual(await readFile(output), original);
    await assert.rejects(renderScriptImages({ ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
    assert.deepEqual((await readdir(directory)).sort(), ["image.png", "master.wav", "result.mp4"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
