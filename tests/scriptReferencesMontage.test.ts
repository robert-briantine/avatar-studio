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
import { ResourceStore } from "../src/resourceStore.js";
import { diagramFromText } from "../src/diagramModel.js";
import { planScriptFiles, renderScriptFiles } from "../src/scriptFiles.js";
import { planScriptImages, renderScriptImages } from "../src/scriptImages.js";
import { prepareScriptReferenceImage, resolveScriptReferences } from "../src/scriptReferences.js";
import { applyScriptOverlays, validateVoiceScript } from "../src/scriptOverlays.js";
import { createScriptVideoBlock, probeVideoFrameCount, validateScriptVideo } from "../src/media.js";

const exec = promisify(execFile);

test("references mixed with all older commands retain the measured visual timeline, delayed narration and file audio", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "references-montage-"));
  try {
    const store = new ResourceStore(path.join(directory, "resources")); await store.init();
    let background = await store.create({ name: "FondCours", type: "image", source: "Un support enregistré." });
    const job = await store.beginImageGeneration(background.id);
    background = await store.finishImageGeneration(background.id, job.imageGeneration!.id,
      await sharp({ create: { width: 400, height: 300, channels: 3, background: "#30a070" } }).png().toBuffer());
    await store.create({ name: "Formule", type: "latex", source: String.raw`\frac{x}{y}`, backgroundImageId: background.id });
    await store.create({ name: "Code", type: "typescript", source: 'const valeur: number = 42;\n', backgroundImageId: background.id });
    const diagram = await sharp({ create: { width: 400, height: 200, channels: 4, background: "white" } })
      .composite([{ input: await sharp({ create: { width: 350, height: 140, channels: 4, background: "#111111" } }).png().toBuffer(), left: 25, top: 30 }]).png().toBuffer();
    await store.create({ name: "Schéma", type: "diagram", source: JSON.stringify(diagramFromText("Voix → Vidéo")),
      diagramPreview: `data:image/png;base64,${diagram.toString("base64")}`, backgroundImageId: background.id });
    const avatar = path.join(directory, "avatar.png"), generated = path.join(directory, "generated.png");
    await sharp({ create: { width: 160, height: 120, channels: 3, background: "blue" } }).png().toFile(avatar);
    await sharp({ create: { width: 160, height: 120, channels: 3, background: "magenta" } }).png().toFile(generated);
    const sound = path.join(directory, "sonore.mp4"), audio = path.join(directory, "narration.wav");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x120:r=20:d=0.4", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=0.4", "-c:v", "libx264", "-c:a", "aac", sound]);
    const script = parseAvatarScript(`Début. {Ref:FondCours} Le fond. {Ref:Formule} La formule. {File:${sound}} Commentaire. ` +
      `{Ref:Code} Le code. {Image:FondCours} Une autre image. {Texte:Titre} Un titre. {Ref:Schéma} Le schéma. ` +
      `{Latex:x+1} Une incrustation. {} Retour. {Ref:FondCours} Le fond revient jusqu’à la fin.`);
    const duration = script.sequences.length / 4;
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${duration}`, audio]);
    const original = await readFile(audio);
    const voice: VoiceAsset = { name: "narration.wav", path: audio, url: "", text: script.narration, presetId: "narrator", voicePrompt: "", script, duration,
      scriptTimings: script.sequences.map((_, sequenceIndex) => ({ sequenceIndex, start: sequenceIndex / 4, end: (sequenceIndex + 1) / 4 })) };
    await validateVoiceScript(voice);
    const references = await resolveScriptReferences(script, store);
    const plan = (await planScriptFiles(voice))!; assert.ok(Math.abs(plan.duration - duration - 0.4) < 0.0001);
    const staging = path.join(directory, "staging.mp4"), output = path.join(directory, "final.mp4");
    let imageCalls = 0, referenceCalls = 0; const avatarDurations: number[] = [];
    await renderScriptFiles({ plan, audioPath: audio, outputPath: staging, width: 160, height: 120, fps: 16,
      resolveReference: async name => { referenceCalls++; return references.get(name)!.path; },
      resolveImage: async content => { assert.equal(content, "FondCours"); imageCalls++; return generated; },
      renderAvatar: async (_wav, target, seconds) => {
        avatarDurations.push(seconds); await createScriptVideoBlock(avatar, target, 160, 120, 16, Math.ceil(seconds * 16), true);
      } });
    await applyScriptOverlays(staging, output, plan.overlays, undefined, plan.duration);
    await validateScriptVideo(output, plan.duration);
    assert.equal(imageCalls, 1); assert.equal(referenceCalls, 4, "repeated Ref commands reuse one prepared image per resource name");
    assert.deepEqual(avatarDurations, plan.spans.filter(span => span.mode === "avatar").map(span => span.narrationEnd! - span.narrationStart!));
    const count = await probeVideoFrameCount(output); assert.equal(count, Math.ceil(plan.duration * 16 - 1e-8));
    const expectedReferences = new Map<string, Buffer>();
    for (const [name, reference] of references) {
      const file = path.join(directory, `expected-${reference.resourceId}.png`);
      await prepareScriptReferenceImage(reference.path, file, 160, 120);
      expectedReferences.set(name, await sharp(file).removeAlpha().raw().toBuffer());
    }
    const { stdout: frames } = await exec("ffmpeg", ["-v", "error", "-i", output, "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 12_000_000 });
    const frameSize = 160 * 120 * 3;
    for (let index = 0; index < count; index++) {
      const seconds = index / 16;
      const span = plan.spans.find(span => seconds + 1e-8 >= span.start && seconds + 1e-8 < span.end)!;
      assert.ok(span, `missing span at frame ${index}`);
      const frame = frames.subarray(index * frameSize, (index + 1) * frameSize);
      if (span.mode === "ref") {
        const expected = expectedReferences.get(span.content)!; let difference = 0;
        for (let i = 0; i < frameSize; i++) difference += Math.abs(frame[i] - expected[i]);
        assert.ok(difference / frameSize < 6, `wrong resource at frame ${index}: ${span.content}`);
      } else {
        const expected = span.mode === "image" ? [255, 0, 255] : span.mode === "file-sound" ? [255, 0, 0] : [0, 0, 255];
        const pixel = (30 * 160 + 80) * 3;
        expected.forEach((value, channel) => assert.ok(Math.abs(frame[pixel + channel] - value) < 8, `wrong ${span.mode} at frame ${index}`));
      }
    }
    const { stdout: pcm } = await exec("ffmpeg", ["-v", "error", "-i", output, "-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 2_000_000 });
    const energy = (seconds: number, frequency: number) => {
      let real = 0, imaginary = 0;
      for (let i = 0; i < 2400; i++) { const sample = pcm.readFloatLE((Math.round(seconds * 48000) + i) * 4);
        real += sample * Math.cos(2 * Math.PI * frequency * i / 48000); imaginary += sample * Math.sin(2 * Math.PI * frequency * i / 48000); }
      return real * real + imaginary * imaginary;
    };
    for (const span of plan.spans) {
      const expected = span.mode === "file-sound" ? 880 : 220;
      assert.ok(energy(span.start + 0.08, expected) > energy(span.start + 0.08, expected === 220 ? 880 : 220) * 20, `wrong audio during ${span.mode}`);
    }
    assert.deepEqual(await readFile(audio), original);
    assert.ok(!(await readdir(directory)).some(name => /^\.script-(files|images)-/.test(name)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reference-only movies require no avatar or generated image, and failed references preserve an existing output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "references-only-"));
  try {
    const resources = new ResourceStore(path.join(directory, "resources")); await resources.init();
    const formula = await resources.create({ name: "Formule seule", type: "latex", source: "x+1" });
    const audio = path.join(directory, "narration.wav"), output = path.join(directory, "final.mp4");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=0.5", audio]);
    const script = parseAvatarScript("{Ref:Formule seule} Une formule, sans retour à l’avatar.");
    const voice: VoiceAsset = { name: "narration.wav", path: audio, url: "", text: script.narration, presetId: "narrator", voicePrompt: "", script, duration: 0.5,
      scriptTimings: [{ sequenceIndex: 0, start: 0, end: 0.5 }] };
    const options = { spans: planScriptImages(voice), audioPath: audio, outputPath: output, width: 160, height: 120, fps: 16,
      resolveReference: async () => resources.previewPath(formula.id)!,
      resolveImage: async () => { assert.fail("references must reuse saved pixels"); },
      renderAvatar: async () => { assert.fail("a reference-only movie must never render the avatar"); } };
    await renderScriptImages(options); assert.equal(await probeVideoFrameCount(output), 8);
    const original = await readFile(output);
    let imageCalls = 0;
    await assert.rejects(renderScriptImages({ ...options,
      spans: [{ mode: "image", content: "new image", start: 0, end: 0.25 }, { mode: "ref", content: "missing", start: 0.25, end: 0.5 }],
      resolveImage: async () => { imageCalls++; return "unused"; }, resolveReference: async () => { throw new RangeError("Ressource indisponible."); }
    }), /Ressource indisponible/);
    assert.equal(imageCalls, 0, "all references must be prepared before any image inference");
    assert.deepEqual(await readFile(output), original);
    await assert.rejects(renderScriptImages({ ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
    assert.deepEqual(await readFile(output), original);
    assert.ok(!(await readdir(directory)).some(name => /^\.script-(files|images)-/.test(name)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
