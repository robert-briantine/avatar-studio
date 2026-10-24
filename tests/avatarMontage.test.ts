import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { parseAvatarScript } from "../src/avatarScript.js";
import type { VoiceAsset } from "../src/avatarStore.js";
import { ScriptImageCache } from "../src/scriptImageCache.js";
import { planScriptFiles, renderScriptFiles } from "../src/scriptFiles.js";
import { applyScriptOverlays, validateVoiceScript } from "../src/scriptOverlays.js";
import { createScriptVideoBlock, probeVideoFrameCount, validateScriptVideo } from "../src/media.js";

const exec = promisify(execFile);

test("a complete mixed scenario keeps every visual, word and soundtrack aligned across multiple insertions", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "avatar-montage-"));
  try {
    const avatar = path.join(directory, "avatar.png");
    const photo = path.join(directory, "photo locale.jpg");
    const mute = path.join(directory, "muette.mp4");
    const sound = path.join(directory, "sonore.mp4");
    const secondSound = path.join(directory, "second clip.mp4");
    const audio = path.join(directory, "narration.wav");
    const staging = path.join(directory, "montage.mp4");
    const output = path.join(directory, "final.mp4");
    await sharp({ create: { width: 160, height: 120, channels: 3, background: "blue" } }).png().toFile(avatar);
    await sharp({ create: { width: 160, height: 120, channels: 3, background: "yellow" } }).jpeg().toFile(photo);
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=160x120:r=20:d=0.2", "-an", "-c:v", "libx264", mute]);
    for (const [file, duration, frequency] of [[sound, 0.35, 880], [secondSound, 0.45, 1320]] as const) {
      await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=160x120:r=20:d=${duration}`,
        "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`, "-c:v", "libx264", "-c:a", "aac", file]);
    }
    const source = `Début. {Texte: Titre} Texte. {Image: licorne} Image. {File:${photo}} Photo. ` +
      `{File:${mute}} Muet. {File:${sound}} Commentaire. {} Retour. {Latex: \\frac{a}{b}} Formule. ` +
      `{File:${secondSound}} Encore. {Image: licorne} Image réutilisée. {} Fin.`;
    const script = parseAvatarScript(source);
    const voice: VoiceAsset = {
      name: "narration.wav", path: audio, url: "", presetId: "narrator", voicePrompt: "",
      script, text: script.narration, duration: script.sequences.length / 4,
      scriptTimings: script.sequences.map((_, sequenceIndex) => ({ sequenceIndex, start: sequenceIndex / 4, end: (sequenceIndex + 1) / 4 }))
    };
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${voice.duration}`, audio]);
    const original = await readFile(audio);
    await validateVoiceScript(voice);
    const plan = (await planScriptFiles(voice))!;
    assert.ok(Math.abs(plan.duration - 3.55) < 0.0001);
    const cache = new ScriptImageCache(path.join(directory, "cache"));
    await cache.init();
    let generations = 0;
    const avatarDurations: number[] = [];
    await renderScriptFiles({
      plan, audioPath: audio, outputPath: staging, width: 160, height: 120, fps: 16,
      resolveImage: async content => (await cache.get(content, async () => {
        generations++;
        return sharp({ create: { width: 160, height: 120, channels: 3, background: "magenta" } }).png().toBuffer();
      })).path,
      renderAvatar: async (_wav, target, duration) => {
        avatarDurations.push(duration);
        await createScriptVideoBlock(avatar, target, 160, 120, 16, Math.ceil(duration * 16), true);
      }
    });
    await applyScriptOverlays(staging, output, plan.overlays, undefined, plan.duration);
    await validateScriptVideo(output, plan.duration);
    assert.deepEqual(avatarDurations, [0.5, 0.75, 0.25, 0.25]);
    assert.equal(generations, 1, "repeated generated images must share cached pixels within the complete scenario");
    assert.equal(await probeVideoFrameCount(output), 57, "multiple insertions must not accumulate rounding drift");
    const { stdout: frames } = await exec("ffmpeg", ["-v", "error", "-i", output, "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 16_000_000 });
    for (let index = 0; index < 57; index++) {
      const seconds = index / 16;
      const span = plan.spans.find(span => seconds + 1e-8 >= span.start && seconds + 1e-8 < span.end)!;
      assert.ok(span, `missing timeline span at frame ${index}`);
      const expected = span.mode === "avatar" ? [0, 0, 255]
        : span.mode === "image" ? [255, 0, 255]
        : span.mode === "file-image" ? [255, 255, 0]
        : span.mode === "file-sound" ? [255, 0, 0] : [0, 128, 0];
      const pixel = index * 160 * 120 * 3 + (40 * 160 + 80) * 3;
      expected.forEach((value, channel) => assert.ok(Math.abs(frames[pixel + channel] - value) < 8, `wrong ${span.mode} visual at frame ${index}`));
      let white = 0;
      for (let offset = index * 160 * 120 * 3; offset < (index + 1) * 160 * 120 * 3; offset += 3) {
        if (frames[offset] > 180 && frames[offset + 1] > 180 && frames[offset + 2] > 180) white++;
      }
      assert.equal(white > 0, plan.overlays.some(overlay => seconds + 1e-8 >= overlay.start && seconds + 1e-8 < overlay.end), `caption leak or missing formula at frame ${index}`);
    }
    const { stdout: pcm } = await exec("ffmpeg", ["-v", "error", "-i", output, "-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 2_000_000 });
    const energy = (seconds: number, frequency: number) => {
      let real = 0, imaginary = 0;
      for (let i = 0; i < 2400; i++) {
        const sample = pcm.readFloatLE((Math.round(seconds * 48000) + i) * 4);
        real += sample * Math.cos(2 * Math.PI * frequency * i / 48000);
        imaginary += sample * Math.sin(2 * Math.PI * frequency * i / 48000);
      }
      return real * real + imaginary * imaginary;
    };
    for (const span of plan.spans) {
      const expected = span.mode === "file-sound" ? span.file.path === sound ? 880 : 1320 : 220;
      for (const other of [220, 880, 1320].filter(frequency => frequency !== expected)) {
        assert.ok(energy(span.start + 0.1, expected) > energy(span.start + 0.1, other) * 15, `wrong soundtrack during ${span.mode}`);
      }
    }
    assert.deepEqual(await readFile(audio), original);
    const restartedCache = new ScriptImageCache(path.join(directory, "cache"));
    await restartedCache.init();
    await restartedCache.get("licorne", async () => { assert.fail("a new render must reuse the complete scenario's image"); });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
