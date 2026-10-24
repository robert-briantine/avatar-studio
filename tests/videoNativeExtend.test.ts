import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import sharp from "sharp";
import { AvatarStore, type AvatarProject } from "../src/avatarStore.js";
import { WAN_S2V_FACE_STABILITY_PROMPT, WAN_S2V_FIXED_FRAMING_PROMPT, WAN_S2V_MODELS, WAN_S2V_NODES } from "../src/wanS2V.js";
import type { PromptGraph } from "../src/workflows.js";
import { parseAvatarScript } from "../src/avatarScript.js";

const exec = promisify(execFile);

for (const variant of ["plain", "captioned", "images", "files"]) {
const captioned = variant === "captioned";
const withImages = variant === "images";
const withFiles = variant === "files";
test(withFiles ? "sound file insertion renders only the two avatar passages and keeps deferred narration"
  : withImages ? "image scripts generate only the two visible Wan passages and keep the original narration"
  : captioned
  ? "Wan Extend adds measured text and LaTeX overlays while preserving the native avatar region"
  : "legacy audio segments still submit one full-WAV native Extend graph and preserve native video frames", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wan-native-api-"));
  const store = new AvatarStore(path.join(directory, "projects"));
  await store.init();
  const project = await store.create("Robot test");
  const base = store.base(project);
  const image = path.join(base, "avatar", "avatar.png");
  const audio = path.join(base, "voice", "source.wav");
  const raw = path.join(directory, "native.mp4");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "#727a83" } }).png().toFile(image);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=880:duration=${withFiles ? 2 : 61.5}`, audio]);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=16:duration=65", "-c:v", "libx264", "-preset", "veryfast", raw]);
  project.avatar = { name: "avatar.png", path: image, url: "", source: "uploaded", identityPrompt: "Preserve the reference blue optical sensors." };
  project.voice = { name: "source.wav", path: audio, url: "", duration: 12, text: "Bonjour\nJe suis un robot", presetId: "robot", voicePrompt: "",
    segments: [{ name: "obsolete.wav", path: path.join(directory, "must-not-be-opened.wav"), url: "", duration: 61.5 }] };
  if (captioned) {
    project.voice.script = parseAvatarScript("{Texte: hello} Bonjour. {} Suite. {Latex: x+1} Formule.");
    project.voice.text = project.voice.script.narration;
    project.voice.duration = 61.5;
    project.voice.scriptTimings = [
      { sequenceIndex: 0, start: 0, end: 1 },
      { sequenceIndex: 1, start: 1, end: 2 },
      { sequenceIndex: 2, start: 2, end: 61.5 }
    ];
  }
  if (withImages) {
    project.voice.script = parseAvatarScript("{Texte: hello} Bonjour. {} Suite. {Image: licorne} Image. {} Fin.");
    project.voice.text = project.voice.script.narration;
    project.voice.duration = 61.5;
    project.voice.scriptTimings = [
      { sequenceIndex: 0, start: 0, end: 0.5 }, { sequenceIndex: 1, start: 0.5, end: 1 },
      { sequenceIndex: 2, start: 1, end: 60.5 }, { sequenceIndex: 3, start: 60.5, end: 61.5 }
    ];
  }
  if (withFiles) {
    const file = path.join(directory, "clip sonore.mp4");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=16:d=0.5",
      "-f", "lavfi", "-i", "sine=frequency=1320:sample_rate=48000:duration=0.5", "-c:v", "libx264", "-c:a", "aac", file]);
    project.voice.script = parseAvatarScript(`{Texte: hello} Bonjour. {} Suite. {File:${file}} Commentaire. {} Fin.`);
    project.voice.text = project.voice.script.narration;
    project.voice.duration = 2;
    project.voice.scriptTimings = project.voice.script.sequences.map((_, sequenceIndex) => ({
      sequenceIndex, start: sequenceIndex / 2, end: (sequenceIndex + 1) / 2
    }));
  }
  await store.save(project);
  const sourceHash = createHash("sha256").update(await readFile(audio)).digest("hex");
  let graph: PromptGraph | undefined;
  let submissions = 0;
  let imageSubmissions = 0;
  const submittedDurations: number[] = [];
  const generatedImage = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#cc2211" } }).png().toBuffer();
  let submittedAudioHash = "";
  let handlerError: unknown;
  const memoryEvents: string[] = [];
  const releaseRequests: unknown[] = [];
  let failExecution = false;
  const info = Object.fromEntries(WAN_S2V_NODES.map(name => [name, {}]));
  Object.assign(info, { UNETLoader: { model: WAN_S2V_MODELS.diffusion }, CLIPLoader: { model: WAN_S2V_MODELS.textEncoder },
    AudioEncoderLoader: { model: WAN_S2V_MODELS.audioEncoder }, VAELoader: { model: WAN_S2V_MODELS.vae } });
  const comfy = createServer(async (req, res) => {
    try {
      res.setHeader("content-type", "application/json");
      if (req.url === "/object_info") return void res.end(JSON.stringify(info));
      if (req.url === "/prompt") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        graph = JSON.parse(Buffer.concat(chunks).toString()).prompt;
        if (Object.values(graph!).some(node => node.class_type === "SaveImage")) {
          imageSubmissions++;
          assert.match(String(graph!["4"].inputs.text), /licorne/);
          return void res.end(JSON.stringify({ prompt_id: "image-test" }));
        }
        submissions++;
        const name = Object.values(graph!).find(n => n.class_type === "LoadAudio")!.inputs.audio as string;
        submittedAudioHash = createHash("sha256").update(await readFile(path.join(directory, "input", name))).digest("hex");
        if (withImages || withFiles) {
          submittedDurations.push(Number((await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(directory, "input", name)])).stdout));
        }
        return void res.end(JSON.stringify({ prompt_id: "native-test" }));
      }
      if (req.url === "/history/native-test") {
        if (failExecution) return void res.end(JSON.stringify({ "native-test": { status: { status_str: "error", message: "inference-test-failure" } } }));
        return void res.end(JSON.stringify({ "native-test": { status: { status_str: "success" }, outputs: { save: { video: [{ filename: "native.mp4", type: "output" }] } } } }));
      }
      if (req.url === "/history/image-test") {
        return void res.end(JSON.stringify({ "image-test": { outputs: { save: { images: [{ filename: "licorne.png" }] } } } }));
      }
      if (req.url?.startsWith("/view?")) {
        if (new URL(req.url, "http://localhost").searchParams.get("filename") === "licorne.png") {
          memoryEvents.push("image-download");
          res.setHeader("content-type", "image/png");
          return void res.end(generatedImage);
        }
        memoryEvents.push("download");
        res.setHeader("content-type", "video/mp4");
        return void res.end(await readFile(raw));
      }
      if (req.url === "/queue") return void res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
      if (req.url === "/free") {
        let body = "";
        for await (const chunk of req) body += chunk;
        releaseRequests.push(JSON.parse(body));
        memoryEvents.push("release");
        // A cleanup outage must not replace the original inference error.
        if (failExecution) res.statusCode = 503;
        return void res.end("{}");
      }
      res.end("{}");
    } catch (error) { handlerError = error; res.statusCode = 500; res.end("{}"); }
  });
  const sockets = new Set<import("node:stream").Duplex>();
  comfy.on("upgrade", (req, socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  comfy.listen(0, "127.0.0.1"); await once(comfy, "listening");
  const comfyPort = (comfy.address() as { port: number }).port;
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), DGX_AVATAR_DATA_DIR: directory, COMFY_INPUT_DIR: path.join(directory, "input"),
      COMFY_URL: `http://127.0.0.1:${comfyPort}`, TTS_URL: `http://127.0.0.1:${comfyPort}`, WAN_TRANSITION_PYTHON: "/nonexistent-python",
      WAN_FREE_MEMORY_BEFORE_VIDEO: "false", WAN_FREE_MEMORY_AFTER_VIDEO: "true" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${origin}/api/projects`)).ok) { ready = true; break; } } catch {}
      await delay(25);
    }
    assert.ok(ready, logs);
    const response = await fetch(`${origin}/api/video/generate`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, quality: "normal", width: 64, height: 64 }) });
    assert.equal(response.status, 202);
    let result: AvatarProject | undefined;
    for (let i = 0; i < 800; i++) {
      result = (await (await fetch(`${origin}/api/project/${project.id}`)).json()).project;
      if (["done", "error"].includes(result!.currentJob?.status || "")) break;
      await delay(25);
    }
    assert.equal(handlerError, undefined);
    assert.equal(result!.currentJob?.status, "done", `${JSON.stringify(result!.currentJob)}\n${logs}`);
    if (withImages || withFiles) {
      assert.equal(imageSubmissions, withImages ? 1 : 0);
      assert.equal(submissions, 2, "only the avatar passages before and after the image must be generated");
      assert.deepEqual(submittedDurations, [1, 1]);
      assert.notEqual(submittedAudioHash, sourceHash, "image narration must not be sent to Wan");
      assert.deepEqual(memoryEvents, [...(withImages ? ["image-download"] : []), "download", "release", "download", "release"]);
      const target = result!.video!.path;
      const frame = async (file: string, seconds: number) => (await exec("ffmpeg", ["-v", "error", "-ss", String(seconds),
        "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
      const picture = await frame(target, withFiles ? 1.25 : 1.5);
      for (const pixel of [0, 32 * 64 + 32, 64 * 64 - 1]) assert.ok(picture[pixel * 3] > picture[pixel * 3 + 2], "the image must replace the full avatar frame");
      assert.deepEqual((await frame(target, 0.25)).subarray(0, 64 * 32 * 3), (await frame(raw, 0.25)).subarray(0, 64 * 32 * 3));
      assert.deepEqual(await frame(target, withFiles ? 2 : 61), await frame(raw, 0.5), "reset must resume the separately generated avatar passage");
      const probe = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", target])).stdout);
      const duration = withFiles ? 2.5 : 61.5;
      assert.ok(Math.abs(Number(probe.streams[0].duration) - duration) <= 1 / 16);
      assert.ok(Math.abs(Number(probe.streams.find((stream: any) => stream.codec_type === "audio").duration) - duration) < 0.03);
      assert.equal(createHash("sha256").update(await readFile(audio)).digest("hex"), sourceHash);
      return;
    }
    assert.equal(submissions, 1);
    assert.deepEqual(memoryEvents, ["download", "release"], "release memory only after retrieving the completed MP4");
    assert.deepEqual(releaseRequests, [{ unload_models: true, free_memory: true }]);
    assert.equal(submittedAudioHash, sourceHash, "upload the complete source WAV unchanged");
    const nodes = Object.values(graph!);
    assert.equal(nodes.filter(n => n.class_type === "WanSoundImageToVideo").length, 1);
    assert.equal(nodes.filter(n => n.class_type === "WanSoundImageToVideoExtend").length, 12);
    assert.equal(nodes.filter(n => n.class_type === "AudioEncoderEncode").length, 1);
    assert.equal(nodes.filter(n => n.class_type === "VAEDecode").length, 13, "12 motion-context decodes plus the single final output decode");
    assert.equal(nodes.filter(n => n.class_type === "VAEEncode").length, 12);
    assert.ok(String(graph!["8"].inputs.text).includes(WAN_S2V_FIXED_FRAMING_PROMPT));
    assert.ok(String(graph!["8"].inputs.text).includes(WAN_S2V_FACE_STABILITY_PROMPT));
    assert.ok(String(graph!["8"].inputs.text).includes(project.avatar!.identityPrompt!));
    const samplerSeeds = Object.entries(graph!).filter(([, node]) => node.class_type === "KSampler")
      .sort(([a], [b]) => Number(a) - Number(b)).map(([, node]) => node.inputs.seed);
    assert.deepEqual(samplerSeeds, samplerSeeds.map((_, index) => 123456 + index));
    assert.ok(!nodes.some(n => ["TrimAudioDuration", "DGXPrepareWanHandoff"].includes(n.class_type)));
    assert.ok(nodes.filter(n => n.class_type.startsWith("WanSoundImageToVideo")).every(n => n.inputs.control_video === undefined));
    assert.ok(!String(graph!["8"].inputs.text).match(/skin|beard|person/i), "a robot must not be prompted as a human");
    const target = result!.video!.path;
    const probe = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", target])).stdout);
    assert.equal(probe.streams[0].avg_frame_rate, "16/1");
    assert.ok(Math.abs(Number(probe.streams[0].duration) - 61.5) <= 1 / 16);
    assert.ok(probe.streams.some((stream: any) => stream.codec_type === "audio"));
    if (captioned) {
      const frame = async (file: string, seconds: number) => (await exec("ffmpeg", ["-v", "error", "-ss", String(seconds),
        "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
      for (const seconds of [0.5, 1.5, 2.5]) {
        const [native, rendered] = await Promise.all([frame(raw, seconds), frame(target, seconds)]);
        assert.deepEqual(rendered.subarray(0, 64 * 32 * 3), native.subarray(0, 64 * 32 * 3));
        if (seconds === 1.5) assert.deepEqual(rendered, native, "reset must remove the caption");
        else assert.notDeepEqual(rendered, native, "text and LaTeX must reach the final Wan video");
      }
      return;
    }
    const hashFrames = async (file: string) => (await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file,
      "-map", "0:v:0", "-frames:v", "984", "-f", "framemd5", "-"], { maxBuffer: 1024 * 1024 })).stdout.split("\n").filter(line => line && !line.startsWith("#"));
    assert.deepEqual(await hashFrames(target), await hashFrames(raw), "assembly must preserve every native image, including a precise cut through H.264 B-frames");

    failExecution = true;
    const failedResponse = await fetch(`${origin}/api/video/generate`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, quality: "normal", width: 64, height: 64 }) });
    assert.equal(failedResponse.status, 202);
    for (let i = 0; i < 200; i++) {
      result = (await (await fetch(`${origin}/api/project/${project.id}`)).json()).project;
      if (result!.currentJob?.status === "error") break;
      await delay(25);
    }
    assert.equal(result!.currentJob?.status, "error", logs);
    assert.match(result!.currentJob?.error || "", /inference-test-failure/);
    assert.equal(releaseRequests.length, 2, "also attempt cleanup after a failed inference");
    assert.deepEqual(memoryEvents, ["download", "release", "release"]);
    assert.match(logs, /Wan memory.*Échec du nettoyage/);
    assert.equal(handlerError, undefined);
  } finally {
    const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
    for (const socket of sockets) socket.destroy();
    comfy.closeAllConnections(); await new Promise<void>(resolve => comfy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
}
