import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { parseAvatarScript } from "../src/avatarScript.js";
import type { VoiceAsset } from "../src/avatarStore.js";
import { planScriptFiles, renderScriptFiles, resolveScriptFiles } from "../src/scriptFiles.js";
import { createScriptVideoBlock, extractScriptFileAudio, probeLocalVideo, probeVideoFrameCount } from "../src/media.js";

const exec = promisify(execFile);
let directory: string;
let image: string, avatar: string, short: string, long: string, sound: string, silentTrack: string, audio: string;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "script-files-"));
  image = path.join(directory, "image locale.jpg");
  avatar = path.join(directory, "avatar.png");
  short = path.join(directory, "court d’été.mp4");
  long = path.join(directory, "long.mp4");
  sound = path.join(directory, "avec son.mp4");
  silentTrack = path.join(directory, "piste silencieuse.mp4");
  audio = path.join(directory, "voix.wav");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "yellow" } }).jpeg().toFile(image);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toFile(avatar);
  for (const [file, duration, change] of [[short, 0.3, 0.15], [long, 0.8, 0.4]] as const) {
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=64x64:r=20:d=${duration}`,
      "-vf", `drawbox=color=green:t=fill:enable='gte(t,${change})'`, "-an", "-c:v", "libx264", file]);
  }
  await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=20:d=0.5",
    "-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*880*t)|0.2*sin(2*PI*1320*t):s=48000:d=0.5",
    "-c:v", "libx264", "-c:a", "aac", sound]);
  await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=20:d=0.5",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=0.5", "-c:v", "libx264", "-c:a", "aac", silentTrack]);
  await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2", audio]);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

function voiceFor(source: string): VoiceAsset {
  const script = parseAvatarScript(source);
  return { name: "voix.wav", path: audio, url: "", text: script.narration, presetId: "narrator", voicePrompt: "", script,
    duration: script.sequences.length / 2,
    scriptTimings: script.sequences.map((_, sequenceIndex) => ({ sequenceIndex, start: sequenceIndex / 2, end: (sequenceIndex + 1) / 2 })) };
}

const frame = async (file: string, seconds: number) => (await exec("ffmpeg", ["-v", "error", "-ss", String(seconds),
  "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;

test("local files are classified by decoded content and audio-track presence", async () => {
  const files = await resolveScriptFiles(parseAvatarScript(`{File:${image}} Photo. {File:${short}} Court. {File:${sound}} Son. {File:${silentTrack}} Silence.`));
  assert.equal(files.get(image)?.kind, "image");
  assert.deepEqual(files.get(short), { kind: "video", path: short, duration: 0.3, hasAudio: false, videoStreamIndex: 0 });
  assert.deepEqual(files.get(sound), { kind: "video", path: sound, duration: 0.5, hasAudio: true, videoStreamIndex: 0 });
  assert.equal((files.get(silentTrack) as { hasAudio: boolean }).hasAudio, true, "a silent audio track still belongs to the file");
});

test("missing files, directories, unsupported files and audio-only files fail explicitly", async () => {
  const text = path.join(directory, "incorrect.mp4");
  await writeFile(text, "not a video");
  for (const file of [path.join(directory, "absent.mp4"), directory, text, audio]) {
    await assert.rejects(resolveScriptFiles(parseAvatarScript(`{File:${file}} Bonjour.`)), /Fichier/);
  }
  await assert.rejects(resolveScriptFiles(parseAvatarScript(`{File:${image}} Bonjour.`), AbortSignal.abort()), { name: "AbortError" });
});

test("sound clips insert their full duration and shift later captions without dropping commentary", async () => {
  const voice = voiceFor(`Avant. {File:${sound}} Commentaire. {} Suite. {Latex:x+1} Formule.`);
  const plan = (await planScriptFiles(voice))!;
  assert.equal(plan.duration, 2.5);
  assert.deepEqual(plan.spans.map(span => ({ mode: span.mode, start: span.start, end: span.end,
    narrationStart: span.narrationStart, narrationEnd: span.narrationEnd })), [
    { mode: "avatar", start: 0, end: 0.5, narrationStart: 0, narrationEnd: 0.5 },
    { mode: "file-sound", start: 0.5, end: 1, narrationStart: undefined, narrationEnd: undefined },
    { mode: "avatar", start: 1, end: 2.5, narrationStart: 0.5, narrationEnd: 2 }
  ]);
  assert.deepEqual(plan.overlays, [{ mode: "latex", content: "x+1", start: 2, end: 2.5 }]);
  assert.equal(voice.text, "Avant. Commentaire. Suite. Formule.");
  await assert.rejects(planScriptFiles({ ...voice, scriptTimings: undefined }), /Régénère la voix/);
});

test("local images and silent videos replace the avatar for exactly their narration", { timeout: 15_000 }, async () => {
  const voice = voiceFor(`{File:${short}} Court. {File:${long}} Long. {File:${image}} Photo.`);
  const plan = (await planScriptFiles(voice))!;
  const output = path.join(directory, "silencieux.mp4");
  await renderScriptFiles({ plan, audioPath: audio, outputPath: output, width: 64, height: 64, fps: 20,
    resolveImage: async () => { assert.fail("local files do not use image generation"); },
    renderAvatar: async () => { assert.fail("local files do not require avatar video"); } });
  assert.equal(await probeVideoFrameCount(output), 30);
  const red = await frame(output, 0.1), held = await frame(output, 0.4);
  assert.ok(red[0] > red[1], "the silent video starts with its first red frame");
  assert.ok(held[1] > held[0], "a short silent clip holds its final green frame instead of looping");
  const next = await frame(output, 0.6), photo = await frame(output, 1.2);
  assert.ok(next[0] > next[1], "the next file starts from its beginning");
  assert.ok(photo[0] > 200 && photo[1] > 200 && photo[2] < 50);
  assert.deepEqual((await planScriptFiles(voice))!.duration, 1.5, "the long silent file is cut to narration length");
});

test("a sound clip keeps its stereo audio and postpones the voice until the avatar returns", { timeout: 15_000 }, async () => {
  const voice = voiceFor(`Avant. {File:${sound}} Commentaire. {} Suite.`);
  const plan = (await planScriptFiles(voice))!;
  const output = path.join(directory, "sonore.mp4");
  const original = await readFile(audio);
  const rendered: number[] = [];
  await renderScriptFiles({ plan, audioPath: audio, outputPath: output, width: 64, height: 64, fps: 20,
    resolveImage: async () => { assert.fail("no image generation"); },
    renderAvatar: async (_wav, target, duration) => {
      rendered.push(duration);
      await createScriptVideoBlock(avatar, target, 64, 64, 20, Math.ceil(duration * 20), true);
    } });
  assert.deepEqual(rendered, [0.5, 1], "commentary and the following standard words share the returning avatar passage");
  const inserted = await frame(output, 0.75), returned = await frame(output, 1.25);
  assert.ok(inserted[0] > inserted[2]);
  assert.ok(returned[2] > returned[0]);
  const { stdout: pcm } = await exec("ffmpeg", ["-v", "error", "-i", output, "-vn", "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 2_000_000 });
  const energy = (seconds: number, frequency: number, channel: number) => {
    let real = 0, imag = 0;
    for (let i = 0; i < 4800; i++) {
      const sample = pcm.readFloatLE((Math.round(seconds * 48000) + i) * 8 + channel * 4);
      real += sample * Math.cos(2 * Math.PI * frequency * i / 48000);
      imag += sample * Math.sin(2 * Math.PI * frequency * i / 48000);
    }
    return real * real + imag * imag;
  };
  assert.ok(energy(0.7, 880, 0) > energy(0.7, 220, 0) * 100, "the narrator must not talk over the clip");
  assert.ok(energy(0.7, 1320, 1) > energy(0.7, 880, 1) * 100, "the file's right audio channel must be retained");
  assert.ok(energy(1.2, 220, 0) > energy(1.2, 880, 0) * 100, "narration resumes after the complete clip");
  assert.deepEqual(await readFile(audio), original);
});

test("file-render failures and cancellation keep an earlier output and remove temporary files", async () => {
  const plan = (await planScriptFiles(voiceFor(`Avant. {File:${image}} Photo.`)))!;
  const output = path.join(directory, "preserved.mp4");
  await writeFile(output, "previous output");
  const options = { plan, audioPath: audio, outputPath: output, width: 64, height: 64, fps: 20,
    resolveImage: async () => image, renderAvatar: async () => { throw new Error("Wan failed"); } };
  await assert.rejects(renderScriptFiles(options), /Wan failed/);
  await assert.rejects(renderScriptFiles({ ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(await readFile(output, "utf8"), "previous output");
  assert.ok(!(await readdir(directory)).some(name => name.startsWith(".script-files-")));
});

test("a file's delayed audio keeps its starting silence and a short track is padded to video end", async () => {
  const delayed = path.join(directory, "son décalé.mkv");
  const wav = path.join(directory, "son décalé.wav");
  await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=20:d=0.7",
    "-itsoffset", "0.2", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=0.2",
    "-c:v", "libx264", "-c:a", "pcm_s16le", delayed]);
  const video = await probeLocalVideo(delayed);
  assert.equal(video.duration, 0.7);
  await extractScriptFileAudio(delayed, wav, video.duration);
  const { stdout: pcm } = await exec("ffmpeg", ["-v", "error", "-i", wav, "-ac", "1", "-f", "f32le", "pipe:1"], { encoding: "buffer" });
  const amplitude = (seconds: number) => {
    let sum = 0;
    for (let i = 0; i < 2400; i++) sum += Math.abs(pcm.readFloatLE((Math.round(seconds * 48000) + i) * 4));
    return sum / 2400;
  };
  assert.ok(amplitude(0.1) < 0.0001);
  assert.ok(amplitude(0.25) > 0.01);
  assert.ok(amplitude(0.6) < 0.0001);
  assert.equal(pcm.length / 4, 33600, "audio must occupy the complete 0.7-second file interval");
});
