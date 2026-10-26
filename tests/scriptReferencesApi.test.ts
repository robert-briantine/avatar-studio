import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import { AvatarStore, type AvatarProject } from "../src/avatarStore.js";
import { ResourceStore } from "../src/resourceStore.js";
import { diagramFromText } from "../src/diagramModel.js";
import { parseAvatarScript } from "../src/avatarScript.js";
import { prepareScriptReferenceImage } from "../src/scriptReferences.js";

const exec = promisify(execFile);

test("Ref preview, TTS and both video APIs use all four saved resource types, preserve bindings and reject errors before jobs or inference", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "script-references-api-"));
  const spoken: string[] = [];
  let inference = 0, wav: Buffer, app: ReturnType<typeof spawn> | undefined, origin = "", logs = "";
  const service = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ backend: { model_id: "Qwen-VoiceDesign", base_model_id: "Qwen-1.7B-Base", name: "direct-voice-design-clone", ready: true, clone_ready: true } }));
    }
    if (req.url === "/v1/audio/speech" || req.url === "/v1/audio/clone") {
      let body = ""; for await (const bytes of req) body += bytes;
      spoken.push(JSON.parse(body).input); res.setHeader("content-type", "audio/wav"); return void res.end(wav);
    }
    if (req.url === "/prompt") inference++;
    res.setHeader("content-type", "application/json"); res.end("{}");
  });
  const stop = async () => {
    if (app && app.exitCode === null && app.signalCode === null) { const closed = once(app, "close"); app.kill("SIGTERM"); await closed; }
  };
  const start = async () => {
    const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>(resolve => reserve.close(() => resolve())); origin = `http://127.0.0.1:${port}`;
    const serviceUrl = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
    app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(port), DGX_AVATAR_DATA_DIR: directory, TTS_URL: serviceUrl, COMFY_URL: serviceUrl, VIDEO_WIDTH: "320", VIDEO_HEIGHT: "240", VIDEO_FPS: "20" },
      stdio: ["ignore", "pipe", "pipe"] });
    app.stdout!.on("data", bytes => { logs += bytes; }); app.stderr!.on("data", bytes => { logs += bytes; });
    for (let i = 0; i < 160; i++) { try { if ((await fetch(`${origin}/api/projects`)).ok) return; } catch {} await delay(25); }
    assert.fail(logs);
  };
  try {
    const store = new AvatarStore(path.join(directory, "projects")); await store.init();
    const project = await store.create("Avatar Ref"); const base = store.base(project);
    const avatar = path.join(base, "avatar/avatar.png"), reference = path.join(base, "voice/reference.wav");
    await sharp({ create: { width: 320, height: 240, channels: 3, background: "blue" } }).png().toFile(avatar);
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=0.25", reference]);
    wav = await readFile(reference);
    project.avatar = { name: "avatar.png", path: avatar, url: "", source: "uploaded" };
    project.voiceFingerprint = { name: "reference.wav", path: reference, url: "", duration: 0.25, presetId: "narrator", voicePrompt: "Une voix claire.", refText: "Bonjour.", createdAt: 1 };
    await store.save(project);
    const resources = new ResourceStore(path.join(directory, "resources")); await resources.init();
    let background = await resources.create({ name: "FondCours", type: "image", source: "Un support de cours." });
    const imageJob = await resources.beginImageGeneration(background.id);
    background = await resources.finishImageGeneration(background.id, imageJob.imageGeneration!.id,
      await sharp({ create: { width: 400, height: 300, channels: 3, background: "#30a070" } }).png().toBuffer());
    const formula = await resources.create({ name: "FormuleEnergie", type: "latex", source: "E=mc^2", backgroundImageId: background.id });
    const code = await resources.create({ name: "ExempleTypeScript", type: "typescript", source: 'const valeur: number = 42;\n', backgroundImageId: background.id });
    const diagramPng = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="160"><rect x="5" y="5" width="220" height="150" fill="white" stroke="black" stroke-width="4"/><path d="M225 80H570" stroke="black" stroke-width="4"/><rect x="570" y="5" width="220" height="150" fill="white" stroke="black" stroke-width="4"/></svg>')).png().toBuffer();
    const diagram = await resources.create({ name: "SchemaTraitement", type: "diagram", source: JSON.stringify(diagramFromText("Voix → Vidéo")),
      diagramPreview: `data:image/png;base64,${diagramPng.toString("base64")}`, backgroundImageId: background.id });
    const draft = await resources.create({ name: "Brouillon", type: "latex" });
    const source = "{Ref:FondCours} Voici le support. {Ref:FormuleEnergie} Voici la formule. {Ref:ExempleTypeScript} Voici le code. {Ref:SchemaTraitement} Voici le schéma.";
    const script = parseAvatarScript(source);
    service.listen(0, "127.0.0.1"); await once(service, "listening"); await start();
    const post = (url: string, body: unknown, method = "POST") => fetch(`${origin}${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const getProject = async (): Promise<AvatarProject> => (await (await fetch(`${origin}/api/project/${project.id}`)).json()).project;
    const completed = async () => {
      let current: AvatarProject | undefined;
      for (let i = 0; i < 500; i++) { current = await getProject(); if (["done", "error"].includes(current.currentJob?.status || "")) break; await delay(25); }
      assert.equal(current?.currentJob?.status, "done", `${JSON.stringify(current?.currentJob)}\n${logs}`); return current!;
    };
    const before = await getProject();
    for (const text of ["{Ref: } Bonjour.", "{Ref:Inconnu} Bonjour.", `{Ref:${draft.name}} Bonjour.`, "{Ref:FondCours}"]) {
      assert.equal((await post("/api/script/preview", { text })).status, 400);
      assert.equal((await post("/api/voice/generate", { projectId: project.id, generationName: "Invalide", text })).status, 400);
    }
    const invalidBatch = await post("/api/batches", { name: "Invalide", items: [{ avatarId: project.id, name: "Introuvable", text: "{Ref:Inconnu} Bonjour." }] });
    assert.equal(invalidBatch.status, 400); assert.match((await invalidBatch.json()).error, /Ligne 1.*Inconnu/);
    assert.deepEqual(await getProject(), before); assert.deepEqual(spoken, []); assert.equal(inference, 0);
    const preview = await post("/api/script/preview", { text: source }); assert.equal(preview.status, 200);
    const plan = await preview.json(); assert.equal(plan.narration, script.narration);
    assert.deepEqual(plan.sequences.map((sequence: any) => sequence.resource.type), ["image", "latex", "typescript", "diagram"]);
    assert.ok(plan.sequences.every((sequence: any) => sequence.resource.previewUrl && !sequence.resource.path));
    assert.deepEqual(spoken, []); assert.equal(inference, 0);
    const created = await post("/api/voice/generate", { projectId: project.id, generationName: "Cours", text: source }); assert.equal(created.status, 202);
    const generationId = (await created.json()).generation.id;
    let current = await completed(); const voice = current.generations!.find(generation => generation.id === generationId)!.voice!;
    assert.deepEqual(spoken, script.sequences.map(sequence => sequence.text)); assert.equal(voice.text, script.narration);
    assert.deepEqual(voice.resourceReferences?.map(binding => binding.resourceId), [background.id, formula.id, code.id, diagram.id]);
    assert.equal(voice.scriptTimings?.length, 4); assert.equal(voice.duration, 1);
    const voiceBytes = await readFile(voice.path);
    assert.equal((await post("/api/video/preview", { projectId: project.id, generationId })).status, 202);
    current = await completed(); const previewVideo = current.generations!.find(generation => generation.id === generationId)!.video!;
    const preservedPreview = await readFile(previewVideo.path);
    const expectFrames = async (video: string) => {
      const { stdout: frames } = await exec("ffmpeg", ["-v", "error", "-i", video, "-an", "-vf", "fps=4", "-frames:v", "4", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 4_000_000 });
      for (const [index, resource] of [background, formula, code, diagram].entries()) {
        const target = path.join(directory, `expected-${index}.png`);
        await prepareScriptReferenceImage(resources.previewPath(resource.id)!, target, 320, 240);
        const expected = await sharp(target).removeAlpha().raw().toBuffer();
        const frame = frames.subarray(index * expected.length, (index + 1) * expected.length);
        assert.equal(frame.length, expected.length); let error = 0;
        for (let i = 0; i < expected.length; i++) error += Math.abs(expected[i] - frame[i]);
        assert.ok(error / expected.length < 5, `wrong ${resource.type} visual in movie: ${error / expected.length}`);
      }
    };
    await expectFrames(previewVideo.path);
    const backgroundFile = resources.previewPath(background.id)!; const backgroundBytes = await readFile(backgroundFile);
    await rm(backgroundFile); const beforeFailure = await getProject();
    for (const route of ["/api/video/preview", "/api/video/generate"]) {
      const invalid = await post(route, { projectId: project.id, generationId }); assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).error, /Ressource.*indisponible/);
    }
    assert.deepEqual(await getProject(), beforeFailure); assert.deepEqual(await readFile(previewVideo.path), preservedPreview);
    await writeFile(backgroundFile, backgroundBytes);
    const renamed = await post(`/api/resources/${code.id}`, { name: "CodeRenommé" }, "PATCH"); assert.equal(renamed.status, 200);
    await stop(); await start();
    assert.equal((await post("/api/video/generate", { projectId: project.id, generationId, width: 320, height: 240 })).status, 202);
    current = await completed(); const final = current.generations![0];
    assert.notEqual(final.id, generationId); assert.equal(final.video?.engine, "wan-s2v");
    assert.deepEqual(final.voice?.resourceReferences, voice.resourceReferences); assert.equal(final.text, source);
    await expectFrames(final.video!.path);
    assert.deepEqual(await readFile(previewVideo.path), preservedPreview); assert.deepEqual(await readFile(final.voice!.path), voiceBytes);
    assert.equal(inference, 0, "saved reference-only movies must never load image or Wan models");
    assert.deepEqual(spoken, script.sequences.map(sequence => sequence.text), "video rerenders must keep the existing continuous narration");
  } finally {
    await stop(); service.closeAllConnections(); if (service.listening) await new Promise<void>(resolve => service.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
