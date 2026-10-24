import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { parseAvatarScript } from "../src/avatarScript.js";
import type { VoiceAsset } from "../src/avatarStore.js";
import { applyScriptOverlays, getScriptOverlays, renderScriptOverlay, validateScriptOverlays, validateVoiceScript } from "../src/scriptOverlays.js";
import { createSilence, probeDuration } from "../src/media.js";

const exec = promisify(execFile);
const script = parseAvatarScript("Avant. {Texte: Bonjour <Robert> & été} Robert. {} Après. {Latex: \\frac{x+1}{y}} Formule. {} Fin.");
const voice: VoiceAsset = {
  name: "test.wav", path: "unused.wav", url: "", text: script.narration,
  presetId: "narrator", voicePrompt: "", script, duration: 5,
  scriptTimings: script.sequences.map((_, sequenceIndex) => ({ sequenceIndex, start: sequenceIndex, end: sequenceIndex + 1 }))
};

test("overlays use measured narration bounds and end at the reset", () => {
  assert.deepEqual(getScriptOverlays(voice), [
    { mode: "text", content: "Bonjour <Robert> & été", start: 1, end: 2 },
    { mode: "latex", content: "\\frac{x+1}{y}", start: 3, end: 4 }
  ]);
  assert.deepEqual(getScriptOverlays({ ...voice, script: undefined, scriptTimings: undefined }), []);
  assert.deepEqual(getScriptOverlays({ ...voice, script: parseAvatarScript("Bonjour."), scriptTimings: undefined }), []);
});

test("old or inconsistent voice bounds require regeneration instead of estimated placement", () => {
  const timings = voice.scriptTimings!;
  for (const scriptTimings of [
    undefined, [], timings.slice(1),
    timings.map((timing, index) => index === 1 ? { ...timing, start: 1.1 } : timing),
    timings.map((timing, index) => index === 1 ? { ...timing, end: NaN } : timing),
    timings.map((timing, index) => index === 1 ? { ...timing, sequenceIndex: 3 } : timing)
  ]) {
    assert.throws(() => getScriptOverlays({ ...voice, scriptTimings }), /Régénère la voix/);
  }
  assert.throws(() => getScriptOverlays({ ...voice, duration: 5.5 }), /Régénère la voix/);
});

test("text and mathematical fractions render on fitted transparent frames", async () => {
  for (const [mode, content] of [
    ["text", "Bonjour <Robert> & été"],
    ["text", "Un mot très long : " + "abcdefghij".repeat(40)],
    ["latex", String.raw`\frac{x_{1}+1}{\sqrt{y}} + \sum_{n=1}^{\infty} n^{-2}`]
  ] as const) {
    const image = await renderScriptOverlay(mode, content, 320, 240);
    const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 320);
    assert.equal(info.height, 240);
    assert.equal(info.channels, 4);
    let visible = 0;
    let white = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      visible++;
      const y = Math.floor(i / 4 / info.width);
      assert.ok(y > info.height * 0.55 && y < info.height * 0.95, "captions must stay at the bottom");
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) white++;
    }
    assert.ok(visible > 100);
    assert.ok(white > 10, "text or formula glyphs must be visible");
  }
});

test("invalid LaTeX is reported and definitions cannot leak between formulas", async () => {
  await renderScriptOverlay("latex", String.raw`\newcommand{\localname}{x}\localname`, 320, 240);
  await assert.rejects(renderScriptOverlay("latex", String.raw`\localname`, 320, 240), /Formule LaTeX invalide/);
  await assert.rejects(renderScriptOverlay("latex", String.raw`\require{html}`, 320, 240), /Formule LaTeX invalide/);
});

test("formula and saved-voice validation reject invalid plans before generation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "voice-script-validation-"));
  try {
    const wav = path.join(directory, "voice.wav");
    await createSilence(wav, 5);
    const saved = { ...voice, path: wav };
    await validateScriptOverlays(script);
    await validateVoiceScript(saved);
    await assert.rejects(validateVoiceScript(saved, "Un autre scénario."), /texte de cette génération/);
    await assert.rejects(validateScriptOverlays(parseAvatarScript(String.raw`{Latex: \invalidmacro} Bonjour.`)), /Formule LaTeX invalide/);
    await assert.rejects(validateVoiceScript({ ...saved, text: "Le mauvais texte." }), /Régénère la voix/);
    await assert.rejects(validateVoiceScript({ ...saved, script: {
      ...script, sequences: script.sequences.map((sequence, index) => index === 0 ? { mode: "standard", text: "Altéré." } : sequence)
    } }), /Régénère la voix/);
    await assert.rejects(validateVoiceScript({ ...saved, script: { ...script, source: "{Texte: sans paroles}" } }), /Régénère la voix/);
    await createSilence(wav, 3);
    await assert.rejects(validateVoiceScript(saved), /durée de la voix/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("captioned video changes only the active lower region and keeps audio and timing", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-overlays-"));
  try {
    const source = path.join(directory, "source.mp4");
    const output = path.join(directory, "output.mp4");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=5",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=5", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
    await applyScriptOverlays(source, output, getScriptOverlays(voice));
    assert.ok(Math.abs(await probeDuration(output) - await probeDuration(source)) < 0.01);
    const frame = async (file: string, seconds: number) => (await exec("ffmpeg", ["-v", "error", "-ss", String(seconds),
      "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
    for (const seconds of [0.9, 1, 1.9, 2, 2.9, 3, 3.9, 4]) {
      const [before, after] = await Promise.all([frame(source, seconds), frame(output, seconds)]);
      assert.deepEqual(after.subarray(0, 320 * 120 * 3), before.subarray(0, 320 * 120 * 3), "the avatar region must remain unchanged");
      if ((seconds >= 1 && seconds < 2) || (seconds >= 3 && seconds < 4)) {
        assert.notDeepEqual(after, before, `missing caption at ${seconds}s`);
      } else {
        assert.deepEqual(after, before, `caption leaked past reset at ${seconds}s`);
      }
    }
    const audioHash = async (file: string) => (await exec("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-"])).stdout;
    assert.equal(await audioHash(output), await audioHash(source));

    const original = await readFile(output);
    await assert.rejects(applyScriptOverlays(source, output, [], undefined, 6), /désynchronisé/);
    assert.deepEqual(await readFile(output), original, "a failed duration check must preserve the old output even without overlays");
    const videoOnly = path.join(directory, "video-only.mp4");
    await exec("ffmpeg", ["-v", "error", "-y", "-i", source, "-map", "0:v:0", "-c:v", "copy", "-an", videoOnly]);
    await assert.rejects(applyScriptOverlays(videoOnly, output, [], undefined, 5), /pistes vidéo et audio/);
    assert.deepEqual(await readFile(output), original);
    await rm(videoOnly);
    await assert.rejects(applyScriptOverlays(output, output, [{
      mode: "latex", content: String.raw`\unknownmacro`, start: 0, end: 1
    }]), /Formule LaTeX invalide/);
    assert.deepEqual(await readFile(output), original, "a failed render must preserve the previous video");
    await assert.rejects(applyScriptOverlays(output, output, getScriptOverlays(voice), AbortSignal.abort()), { name: "AbortError" });
    assert.deepEqual((await readdir(directory)).sort(), ["output.mp4", "source.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
