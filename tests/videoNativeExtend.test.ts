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

const exec = promisify(execFile);

test("legacy audio segments still submit one full-WAV native Extend graph and preserve native video frames", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wan-native-api-"));
  const store = new AvatarStore(path.join(directory, "projects"));
  await store.init();
  const project = await store.create("Robot test");
  const base = store.base(project);
  const image = path.join(base, "avatar", "avatar.png");
  const audio = path.join(base, "voice", "source.wav");
  const raw = path.join(directory, "native.mp4");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "#727a83" } }).png().toFile(image);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=61.5", audio]);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=16:duration=65", "-c:v", "libx264", "-preset", "veryfast", raw]);
  project.avatar = { name: "avatar.png", path: image, url: "", source: "uploaded", identityPrompt: "Preserve the reference blue optical sensors." };
  project.voice = { name: "source.wav", path: audio, url: "", duration: 12, text: "Bonjour\nJe suis un robot", presetId: "robot", voicePrompt: "",
    segments: [{ name: "obsolete.wav", path: path.join(directory, "must-not-be-opened.wav"), url: "", duration: 61.5 }] };
  await store.save(project);
  const sourceHash = createHash("sha256").update(await readFile(audio)).digest("hex");
  let graph: PromptGraph | undefined;
  let submissions = 0;
  let submittedAudioHash = "";
  let handlerError: unknown;
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
        submissions++;
        const name = Object.values(graph!).find(n => n.class_type === "LoadAudio")!.inputs.audio as string;
        submittedAudioHash = createHash("sha256").update(await readFile(path.join(directory, "input", name))).digest("hex");
        return void res.end(JSON.stringify({ prompt_id: "native-test" }));
      }
      if (req.url === "/history/native-test") return void res.end(JSON.stringify({ "native-test": { status: { status_str: "success" }, outputs: { save: { video: [{ filename: "native.mp4", type: "output" }] } } } }));
      if (req.url?.startsWith("/view?")) {
        res.setHeader("content-type", "video/mp4");
        return void res.end(await readFile(raw));
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
      COMFY_URL: `http://127.0.0.1:${comfyPort}`, TTS_URL: `http://127.0.0.1:${comfyPort}`, WAN_TRANSITION_PYTHON: "/nonexistent-python" },
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
    for (let i = 0; i < 200; i++) {
      result = (await (await fetch(`${origin}/api/project/${project.id}`)).json()).project;
      if (["done", "error"].includes(result!.currentJob?.status || "")) break;
      await delay(25);
    }
    assert.equal(handlerError, undefined);
    assert.equal(result!.currentJob?.status, "done", `${JSON.stringify(result!.currentJob)}\n${logs}`);
    assert.equal(submissions, 1);
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
    const hashFrames = async (file: string) => (await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file,
      "-map", "0:v:0", "-frames:v", "984", "-f", "framemd5", "-"], { maxBuffer: 1024 * 1024 })).stdout.split("\n").filter(line => line && !line.startsWith("#"));
    assert.deepEqual(await hashFrames(target), await hashFrames(raw), "assembly must preserve every native image, including a precise cut through H.264 B-frames");
  } finally {
    const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
    for (const socket of sockets) socket.destroy();
    comfy.closeAllConnections(); await new Promise<void>(resolve => comfy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
