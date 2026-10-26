import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import sharp from "sharp";
import { AvatarStore, type AvatarProject } from "../src/avatarStore.js";
import { prepareVoiceFingerprintAudio } from "../src/voiceFingerprint.js";

const exec = promisify(execFile);

test("voice references decode common audio formats and enforce the three-second boundary", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "voice-reference-"));
  try {
    const original = path.join(directory, "original.wav");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
      "sine=frequency=220:sample_rate=48000:duration=3", "-ac", "2", original]);
    for (const extension of ["wav", "mp3", "flac", "m4a", "ogg", "aac"]) {
      const input = extension === "wav" ? original : path.join(directory, `input.${extension}`);
      if (input !== original) await exec("ffmpeg", ["-v", "error", "-y", "-i", original, input]);
      const target = path.join(directory, `converted-${extension}.wav`);
      assert.ok(await prepareVoiceFingerprintAudio(input, target) >= 3, extension);
      const { stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", target]);
      const stream = JSON.parse(stdout).streams[0];
      assert.equal(stream.codec_name, "pcm_s16le");
      assert.equal(stream.sample_rate, "24000");
      assert.equal(stream.channels, 1);
    }
    const short = path.join(directory, "short.wav");
    await exec("ffmpeg", ["-v", "error", "-y", "-i", original, "-t", "2.99", short]);
    await assert.rejects(prepareVoiceFingerprintAudio(short, path.join(directory, "rejected.wav")), /au moins 3 secondes/);
    const corrupt = path.join(directory, "fake.wav");
    await writeFile(corrupt, "not an audio file");
    await assert.rejects(prepareVoiceFingerprintAudio(corrupt, path.join(directory, "invalid.wav")), /Impossible de lire/);
    await assert.rejects(prepareVoiceFingerprintAudio(original, path.join(directory, "aborted.wav"), AbortSignal.abort()), { name: "AbortError" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file and YouTube imports persist usable references, preserve history on failure and refresh clone cache keys", { timeout: 35_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "voice-upload-api-"));
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  let origin: string;
  let wav: Buffer;
  let youtubeWav: Buffer;
  const youtubeMetadataFile = path.join(directory, "youtube-metadata.json");
  const youtubeTool = path.join(directory, "fake-yt-dlp");
  const cloneRequests: Array<{ ref_audio: string; ref_text: string; reference_key: string }> = [];
  const tts = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ backend: { model_id: "Qwen-VoiceDesign", base_model_id: "Qwen-1.7B-Base",
        name: "direct-voice-design-clone", ready: true, clone_ready: true } }));
    } else if (req.url === "/youtube-source.wav") {
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), youtubeWav.length - 1) : youtubeWav.length - 1;
      res.writeHead(range ? 206 : 200, { "content-type": "audio/wav", "accept-ranges": "bytes",
        "content-length": end - start + 1, ...(range ? { "content-range": `bytes ${start}-${end}/${youtubeWav.length}` } : {}) });
      res.end(youtubeWav.subarray(start, end + 1));
    } else if (req.url === "/v1/audio/clone") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      cloneRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.setHeader("content-type", "audio/wav");
      res.end(wav);
    } else res.writeHead(404).end();
  });
  const start = async () => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    const ttsUrl = `http://127.0.0.1:${(tts.address() as { port: number }).port}`;
    child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(port), DGX_AVATAR_DATA_DIR: directory, TTS_URL: ttsUrl, COMFY_URL: ttsUrl, YT_DLP_PATH: youtubeTool },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout!.on("data", chunk => { output += chunk; });
    child.stderr!.on("data", chunk => { output += chunk; });
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${origin}/api/projects`)).ok) return; } catch {}
      if (child.exitCode !== null) break;
      await delay(25);
    }
    assert.fail(`Server did not start: ${output}`);
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "close");
      child.kill("SIGTERM");
      await stopped;
    }
  };
  try {
    const input = path.join(directory, "source.wav");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", input]);
    wav = await readFile(input);
    const store = new AvatarStore(path.join(directory, "projects"));
    await store.init();
    const project = await store.create("Import voix");
    const emptyProject = await store.create("Sans avatar");
    const base = store.base(project);
    const image = path.join(base, "avatar/avatar.png");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toFile(image);
    project.avatar = { name: "avatar.png", path: image, url: "", source: "uploaded" };
    const previous = path.join(base, "voice/previous.wav");
    await writeFile(previous, wav);
    project.voiceFingerprint = { name: "previous.wav", path: previous, url: "", duration: 3,
      refText: "Ancienne voix.", presetId: "custom", voicePrompt: "", createdAt: 1 };
    project.generations = [{ id: "old", name: "Ancienne génération", text: "Bonjour.",
      status: "voice-ready", createdAt: 1, updatedAt: 1,
      voice: { ...project.voiceFingerprint, text: "Bonjour." } }];
    await store.save(project);
    tts.listen(0, "127.0.0.1");
    await once(tts, "listening");
    const youtubeSource = path.join(directory, "youtube-source.wav");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=6", youtubeSource]);
    youtubeWav = await readFile(youtubeSource);
    await writeFile(youtubeMetadataFile, JSON.stringify({ title: "Vidéo de test", duration: 6,
      url: `http://127.0.0.1:${(tts.address() as { port: number }).port}/youtube-source.wav` }));
    await writeFile(youtubeTool, `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(youtubeMetadataFile)},'utf8'));\n`, { mode: 0o755 });
    await start();
    const getProject = async (): Promise<AvatarProject> => (await (await fetch(`${origin}/api/project/${project.id}`)).json()).project;
    const completed = async (status: "done" | "error") => {
      for (let i = 0; i < 400; i++) {
        const current = await getProject();
        if (current.currentJob && !["queued", "running"].includes(current.currentJob.status)) {
          assert.equal(current.currentJob.status, status, `${current.currentJob.error}\n${output}`);
          return current;
        }
        await delay(25);
      }
      assert.fail(`Job did not complete: ${output}`);
    };
    const upload = (bytes?: Uint8Array, id = project.id, name = "voix.wav", type = "audio/wav") => {
      const form = new FormData();
      form.append("projectId", id);
      if (bytes) form.append("audio", new Blob([bytes], { type }), name);
      return fetch(`${origin}/api/voice/fingerprint/upload`, { method: "POST", body: form });
    };
    const requirements = await (await fetch(`${origin}/api/voice/fingerprint/requirements`)).json();
    const originalGenerations = (await getProject()).generations;
    assert.deepEqual(requirements, { minDurationSeconds: 3, maxFileSizeBytes: 30 * 1024 * 1024 });
    assert.equal((await upload()).status, 400);
    assert.equal((await upload(new Uint8Array())).status, 400);
    assert.equal((await upload(wav, "unknown")).status, 400);
    assert.equal((await upload(wav, emptyProject.id)).status, 400);
    const oversized = await upload(new Uint8Array(requirements.maxFileSizeBytes + 1));
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /30 Mo/);

    const short = path.join(directory, "short.wav");
    await exec("ffmpeg", ["-v", "error", "-y", "-i", input, "-t", "2.99", short]);
    for (const bytes of [Buffer.from("corrupt audio"), await readFile(short), await readFile(image)]) {
      assert.equal((await upload(bytes)).status, 202);
      const failed = await completed("error");
      assert.ok(failed.currentJob?.error);
      assert.equal(failed.voiceFingerprint!.name, "previous.wav");
      assert.deepEqual(failed.generations, originalGenerations);
      assert.deepEqual(await readFile(previous), wav);
    }

    const imported = await upload(wav, project.id, "ma voix.wav", "application/octet-stream");
    assert.equal(imported.status, 202, "content decoding accepts audio even without an audio MIME type");
    let current = await completed("done");
    assert.equal(current.voiceFingerprint!.duration, 3);
    assert.equal(current.voiceFingerprint!.source, "uploaded");
    assert.equal(current.voiceFingerprint!.originalName, "ma voix.wav");
    assert.equal(current.voiceFingerprint!.presetId, "custom", "uploaded voices receive no fantasy preset effect");
    assert.equal(current.voiceFingerprint!.refText, "");
    assert.deepEqual(current.generations, originalGenerations);
    assert.equal((await fetch(`${origin}${current.voiceFingerprint!.url}`)).status, 200);
    const fingerprintPath = current.voiceFingerprint!.path;
    const narrate = async () => {
      const response = await fetch(`${origin}/api/voice/generate`, { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, generationName: "Nouvelle voix", text: "Bonjour à toutes et à tous." }) });
      assert.equal(response.status, 202);
      await completed("done");
    };
    await narrate();
    assert.equal(cloneRequests[0].ref_audio, fingerprintPath);
    assert.equal(cloneRequests[0].ref_text, "");
    assert.equal((await upload(wav)).status, 202);
    await completed("done");
    await narrate();
    assert.equal(cloneRequests.length, 2);
    assert.notEqual(cloneRequests[0].reference_key, cloneRequests[1].reference_key, "replacement must invalidate the TTS prompt cache");

    const youtube = (url: string, start: string) => fetch(`${origin}/api/voice/fingerprint/youtube`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, url, start })
    });
    const beforeYouTube = await getProject();
    for (const [url, start] of [["https://example.com/video", "00:00"], ["https://youtu.be/BaW_jenozKc", "-1"],
      ["https://youtube.com/playlist?list=abc", "1:00"]]) {
      assert.equal((await youtube(url, start)).status, 400);
      assert.deepEqual(await getProject(), beforeYouTube, "invalid input must not change the project or job");
    }
    assert.equal((await youtube("https://youtu.be/BaW_jenozKc", "00:04")).status, 202);
    current = await completed("error");
    assert.match(current.currentJob!.error!, /début plus tôt/);
    assert.deepEqual(current.voiceFingerprint, beforeYouTube.voiceFingerprint);
    assert.deepEqual(current.generations, beforeYouTube.generations);

    assert.equal((await youtube("https://youtu.be/BaW_jenozKc?list=ignored", "00:01.5")).status, 202);
    current = await completed("done");
    assert.equal(current.voiceFingerprint!.source, "youtube");
    assert.equal(current.voiceFingerprint!.sourceUrl, "https://www.youtube.com/watch?v=BaW_jenozKc");
    assert.equal(current.voiceFingerprint!.startSeconds, 1.5);
    assert.equal(current.voiceFingerprint!.duration, 3);
    assert.equal(current.voiceFingerprint!.originalName, "Vidéo de test");
    assert.equal((await fetch(`${origin}${current.voiceFingerprint!.url}`)).status, 200);
    assert.deepEqual(current.generations, beforeYouTube.generations);
    await narrate();
    assert.equal(cloneRequests.length, 3);
    assert.equal(cloneRequests[2].ref_audio, current.voiceFingerprint!.path);
    assert.notEqual(cloneRequests[2].reference_key, cloneRequests[1].reference_key);
    await stop();
    await start();
    current = await getProject();
    assert.equal(current.voiceFingerprint!.source, "youtube");
    assert.equal(current.voiceFingerprint!.startSeconds, 1.5);
    assert.equal(current.generations.length, 4);
    assert.ok((await readFile(current.voiceFingerprint!.path)).length > 44);
    assert.deepEqual((await readdir(path.join(directory, "work"))).filter(name => /^voice-(import|youtube)-/.test(name)), [],
      "temporary uploads and YouTube clips are cleaned after success and rejection");
  } finally {
    await stop();
    tts.closeAllConnections();
    await new Promise<void>(resolve => tts.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
