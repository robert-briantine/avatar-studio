import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import { AvatarStore, type AvatarProject } from "../src/avatarStore.js";
import { createSilence } from "../src/media.js";
import { parseAvatarScript } from "../src/avatarScript.js";

const exec = promisify(execFile);

test("voice API sends only narration, preserves the scenario and rejects invalid scripts before mutation", { timeout: 35_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "avatar-script-api-"));
  const requests: Array<{ route: string; input: string }> = [];
  let imageRequests = 0;
  let imagePrompt = "";
  let firstVoice = true;
  let releaseVoice!: () => void;
  let notifyVoiceStarted!: () => void;
  const voiceGate = new Promise<void>(resolve => { releaseVoice = resolve; });
  const voiceStarted = new Promise<void>(resolve => { notifyVoiceStarted = resolve; });
  let wav: Buffer;
  const generatedImage = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#cc2211" } }).png().toBuffer();
  // Both health checks and synthesis stay on this local fake service.
  const tts = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ backend: {
        model_id: "Qwen-VoiceDesign", base_model_id: "Qwen-1.7B-Base",
        name: "direct-voice-design-clone", ready: true, clone_ready: true
      } }));
    } else if (req.url === "/v1/audio/speech" || req.url === "/v1/audio/clone") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ route: req.url, input: body.input });
      if (firstVoice) {
        firstVoice = false;
        notifyVoiceStarted();
        await voiceGate;
      }
      res.setHeader("content-type", "audio/wav");
      res.end(wav);
    } else if (req.url === "/prompt") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const graph = JSON.parse(Buffer.concat(chunks).toString("utf8")).prompt;
      imageRequests++;
      imagePrompt = graph["4"].inputs.text;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ prompt_id: "image-test" }));
    } else if (req.url === "/history/image-test") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ "image-test": { outputs: { save: { images: [{ filename: "licorne.png" }] } } } }));
    } else if (req.url?.startsWith("/view?")) {
      res.setHeader("content-type", "image/png");
      res.end(generatedImage);
    } else {
      res.writeHead(404).end();
    }
  });
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  };
  try {
    const store = new AvatarStore(path.join(directory, "projects"));
    await store.init();
    const project = await store.create("Scénario test");
    const base = store.base(project);
    const reference = path.join(base, "voice/reference.wav");
    await createSilence(reference, 0.4);
    wav = await readFile(reference);
    const avatarPath = path.join(base, "avatar/avatar.png");
    await sharp({ create: { width: 320, height: 240, channels: 3, background: "#112233" } }).png().toFile(avatarPath);
    project.avatar = { name: "avatar.png", path: avatarPath, url: "", source: "uploaded" };
    const localImage = path.join(directory, "image locale.jpg");
    await sharp({ create: { width: 320, height: 240, channels: 3, background: "#11bb33" } }).jpeg().toFile(localImage);
    project.voiceFingerprint = {
      name: "reference.wav", path: reference, url: "", duration: 0.4,
      refText: "Bonjour.", presetId: "narrator", voicePrompt: "Une voix claire.", createdAt: Date.now()
    };
    const oldScript = parseAvatarScript("{Image: ancien} Ancienne voix. {} Suite.");
    project.generations = [{
      id: "untimed", name: "Ancienne voix", text: oldScript.source, script: oldScript,
      createdAt: 1, updatedAt: 1, status: "done",
      voice: { ...project.voiceFingerprint, text: oldScript.narration, script: oldScript },
      video: { name: "old.mp4", path: path.join(base, "video/old.mp4"), url: "", engine: "wan-s2v" }
    }];
    await store.save(project);

    tts.listen(0, "127.0.0.1");
    await once(tts, "listening");
    const ttsUrl = `http://127.0.0.1:${(tts.address() as { port: number }).port}`;
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const getProject = async (): Promise<AvatarProject> => (await (await fetch(`${origin}/api/project/${project.id}`)).json()).project;
    const post = (route: string, body: Record<string, unknown>) => fetch(`${origin}${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const start = async () => {
      child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, PORT: String(port), DGX_AVATAR_DATA_DIR: directory, TTS_URL: ttsUrl, COMFY_URL: ttsUrl,
          VIDEO_WIDTH: "320", VIDEO_HEIGHT: "240", VIDEO_FPS: "10" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout!.on("data", bytes => { output += bytes; });
      child.stderr!.on("data", bytes => { output += bytes; });
      for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`${origin}/api/projects`)).ok) return; } catch {}
        if (child.exitCode !== null) break;
        await delay(25);
      }
      assert.fail(`Test server did not start: ${output}`);
    };
    const completedProject = async () => {
      for (let i = 0; i < 500; i++) {
        const current = await getProject();
        assert.notEqual(current.currentJob?.status, "error", `${current.currentJob?.error}\n${output}`);
        if (current.currentJob?.status === "done") return current;
        await delay(25);
      }
      assert.fail(`Voice job did not complete: ${output}`);
    };
    await start();

    const source = `Bonjour. {Texte: hello} Je suis Robert. {} Suite. {Latex: \\frac{x}{y}} Une formule. {} {Image: licorne} Une image. {} {File:${localImage}} Un fichier. {} Fin.`;
    const script = parseAvatarScript(source);
    const draftResponse = await post(`/api/project/${project.id}/generations`, { name: "Essai", text: source });
    assert.equal(draftResponse.status, 201);
    const { generation: draft } = await draftResponse.json();
    assert.equal(draft.text, source);
    assert.deepEqual(draft.script, script);

    // Syntax and empty narration errors must leave history, text and jobs intact.
    const before = await getProject();
    for (const route of ["/api/video/preview", "/api/video/generate"]) {
      const response = await post(route, { projectId: project.id, generationId: "untimed" });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Régénère la voix/);
    }
    for (const text of ["{Latext: x} Bonjour.", "{Image: licorne}", "{Texte: x",
      "Avant. {Texte: vide} {} Suite.", String.raw`{Latex: \invalidmacro} Bonjour.`]) {
      assert.equal((await post(`/api/project/${project.id}/generations`, { name: "Invalide", text })).status, 400);
      assert.equal((await post("/api/voice/generate", { projectId: project.id, generationId: draft.id, text })).status, 400);
    }
    const missingFile = await post("/api/voice/generate", {
      projectId: project.id, generationId: draft.id, text: `{File:${path.join(directory, "absent.mp4")}} Bonjour.`
    });
    assert.equal(missingFile.status, 400);
    assert.match((await missingFile.json()).error, /Fichier local absent/);
    assert.deepEqual(await getProject(), before);
    assert.deepEqual(requests, []);

    const invalidBatch = await post("/api/batches", {
      name: "Invalide", items: [{ avatarId: project.id, name: "Invalide", text: "{Image: licorne}" }]
    });
    assert.equal(invalidBatch.status, 400);
    assert.match((await invalidBatch.json()).error, /Ligne 1/);
    assert.deepEqual((await (await fetch(`${origin}/api/batches`)).json()).batches, []);
    const badFormulaBatch = await post("/api/batches", {
      name: "Formule invalide", items: [{ avatarId: project.id, name: "Erreur", text: String.raw`{Latex: \invalidmacro} Bonjour.` }]
    });
    assert.equal(badFormulaBatch.status, 400);
    assert.match((await badFormulaBatch.json()).error, /Ligne 1.*LaTeX invalide/);
    assert.deepEqual((await (await fetch(`${origin}/api/batches`)).json()).batches, []);
    assert.deepEqual(requests, [], "validation must not contact TTS");
    assert.equal(imageRequests, 0, "validation must not submit a ComfyUI workflow");

    assert.equal((await post("/api/voice/generate", { projectId: project.id, generationId: draft.id, text: source })).status, 202);
    await voiceStarted;
    const duringVoice = await getProject();
    assert.equal(duringVoice.currentJob?.status, "running");
    const renameAvatar = (name: string) => fetch(`${origin}/api/project/${project.id}/name`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name })
    });
    const refusedRename = await renameAvatar("Renommage pendant la voix");
    assert.equal(refusedRename.status, 409);
    assert.match((await refusedRename.json()).error, /Renommage indisponible/);
    assert.equal((await getProject()).name, duringVoice.name);
    assert.deepEqual(await readFile(reference), wav, "a blocked rename must leave the voice reference at its original path");
    releaseVoice();
    let current = await completedProject();
    assert.equal((await renameAvatar("Renommage après génération")).status, 200);
    current = await getProject();
    assert.equal(current.name, "Renommage après génération");
    assert.deepEqual(await readFile(current.voiceFingerprint!.path), wav);
    await readFile(current.generations![0].voice!.path);
    assert.deepEqual(requests, script.sequences.map(sequence => ({ route: "/v1/audio/clone", input: sequence.text })));
    assert.equal(current.generations?.[0].text, source);
    assert.deepEqual(current.generations?.[0].script, script);
    assert.equal(current.generations?.[0].voice?.text, script.narration);
    assert.deepEqual(current.generations?.[0].voice?.script, script);
    const timings = current.generations?.[0].voice?.scriptTimings!;
    assert.equal(timings.length, script.sequences.length);
    timings.forEach((timing, index) => {
      assert.equal(timing.sequenceIndex, index);
      assert.ok(Math.abs(timing.start - index * 0.4) < 0.001);
      assert.ok(Math.abs(timing.end - (index + 1) * 0.4) < 0.001);
    });
    assert.ok(Math.abs(current.generations![0].voice!.duration! - timings.at(-1)!.end) < 0.001);

    assert.equal((await post("/api/video/preview", { projectId: project.id, generationId: draft.id })).status, 202);
    current = await completedProject();
    const video = current.generations![0].video!;
    for (const timing of timings) {
      const { stdout } = await exec("ffmpeg", ["-v", "error", "-ss", String((timing.start + timing.end) / 2),
        "-i", video.path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
      let white = 0;
      for (let i = 0; i < stdout.length; i += 3) if (stdout[i] > 200 && stdout[i + 1] > 200 && stdout[i + 2] > 200) white++;
      const sequence = script.sequences[timing.sequenceIndex];
      assert.equal(white > 0, sequence.mode === "text" || sequence.mode === "latex", `incorrect overlay in ${sequence.mode} sequence`);
      const center = (120 * 320 + 160) * 3;
      assert.equal(stdout[center] > stdout[center + 2], sequence.mode === "image", "images must replace the avatar frame");
    }
    assert.equal(imageRequests, 1);
    assert.match(imagePrompt, /licorne/);

    const legacySource = "{Image: licorne} Bonjour. {} Au revoir.";
    assert.equal((await post("/api/voice/generate", { projectId: project.id, text: legacySource })).status, 202);
    current = await completedProject();
    assert.deepEqual(requests.slice(-2), [
      { route: "/v1/audio/speech", input: "Bonjour." },
      { route: "/v1/audio/clone", input: "Au revoir." }
    ]);
    assert.equal(current.voice?.text, "Bonjour. Au revoir.");
    assert.equal(current.voice?.script?.source, legacySource);
    assert.equal(current.voice?.scriptTimings?.length, 2, "image-only commands also need measured voice bounds");

    await stop();
    await start();
    current = await getProject();
    assert.deepEqual(current.generations?.[0].script, script);
    assert.deepEqual(current.generations?.[0].voice?.script, script);
    assert.deepEqual(current.generations?.[0].voice?.scriptTimings, timings);
    assert.equal(current.voice?.script?.source, legacySource);
    assert.equal(requests.length, script.sequences.length + 2);
    assert.equal((await post("/api/video/preview", { projectId: project.id, generationId: draft.id })).status, 202);
    await completedProject();
    assert.equal(imageRequests, 1, "a server restart must reuse the persisted image");

    // Scripts without overlays retain the existing single-request voice path.
    assert.equal((await post("/api/voice/generate", { projectId: project.id, text: "Une phrase. Et une autre." })).status, 202);
    current = await completedProject();
    assert.deepEqual(requests.at(-1), { route: "/v1/audio/speech", input: "Une phrase. Et une autre." });
    assert.equal(current.voice?.scriptTimings, undefined);

    assert.equal((await post("/api/voice/generate", {
      projectId: project.id, generationName: "Image seule", text: "{Image: licorne} C’est une licorne."
    })).status, 202);
    current = await completedProject();
    assert.equal((await post("/api/video/generate", {
      projectId: project.id, generationId: current.generations![0].id, width: 64, height: 64
    })).status, 202);
    current = await completedProject();
    assert.equal(current.generations![0].video?.engine, "wan-s2v");
    assert.equal(imageRequests, 1, "image-only video uses cached pixels and requires no Wan models");

    const sound = path.join(directory, "vidéo sonore.mp4");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=20:d=0.5",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=0.5", "-c:v", "libx264", "-c:a", "aac", sound]);
    assert.equal((await post("/api/voice/generate", {
      projectId: project.id, generationName: "Vidéo sonore", text: `Avant. {File:${sound}} Commentaire. {} Suite. {Texte:Fin} Dernière phrase.`
    })).status, 202);
    current = await completedProject();
    const soundGeneration = current.generations![0].id;
    assert.equal((await post("/api/video/preview", { projectId: project.id, generationId: soundGeneration })).status, 202);
    current = await completedProject();
    assert.ok(Math.abs(current.generations![0].video!.duration! - 2.1) < 0.001, "file sound adds its complete duration before commentary");
    const frame = async (seconds: number) => (await exec("ffmpeg", ["-v", "error", "-ss", String(seconds),
      "-i", current.generations![0].video!.path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
    const inserted = await frame(0.6), resumed = await frame(1.1), caption = await frame(1.9);
    const center = (120 * 320 + 160) * 3;
    assert.ok(inserted[center] > inserted[center + 2]);
    assert.ok(resumed[center] < resumed[center + 2]);
    assert.ok([...caption].some((value, index) => index % 3 === 0 && value > 200 && caption[index + 1] > 200 && caption[index + 2] > 200), "captions must shift past the inserted clip");

    assert.equal((await post("/api/voice/generate", {
      projectId: project.id, generationName: "Photo locale", text: `{File:${localImage}} Une photo.`
    })).status, 202);
    current = await completedProject();
    const photoGeneration = current.generations![0].id;
    assert.equal(current.generations![0].voice?.scriptTimings?.length, 1);
    await rename(localImage, `${localImage}.away`);
    const beforeMissing = await getProject();
    for (const route of ["/api/video/preview", "/api/video/generate"]) {
      assert.equal((await post(route, { projectId: project.id, generationId: photoGeneration })).status, 400);
    }
    assert.deepEqual(await getProject(), beforeMissing, "missing input files must not mutate history or start jobs");
    await rename(`${localImage}.away`, localImage);
    assert.equal((await post("/api/video/generate", {
      projectId: project.id, generationId: photoGeneration, width: 64, height: 64
    })).status, 202);
    current = await completedProject();
    assert.equal(current.generations![0].video?.engine, "wan-s2v", "local-image video needs no Wan models");

    const literalSource = String.raw`Voici \{Texte: exemple\}. {Texte:Titre} Dicte \{x\}. {} Fin.`;
    assert.equal((await post("/api/voice/generate", {
      projectId: project.id, generationName: "Accolades littérales", text: literalSource
    })).status, 202);
    current = await completedProject();
    assert.deepEqual(requests.slice(-3).map(request => request.input), ["Voici {Texte: exemple}.", "Dicte {x}.", "Fin."]);
    assert.equal(current.generations![0].text, literalSource);
    assert.equal(current.generations![0].voice?.text, "Voici {Texte: exemple}. Dicte {x}. Fin.");
    assert.equal((await post("/api/video/preview", { projectId: project.id, generationId: current.generations![0].id })).status, 202);
    await completedProject();
    const unvoiced = await post(`/api/project/${project.id}/generations`, { name: "Sans voix", text: "Cette génération n’a pas encore de voix." });
    assert.equal(unvoiced.status, 201);
    const unvoicedGeneration = (await unvoiced.json()).generation;
    const beforeUnvoiced = await getProject();
    for (const route of ["/api/video/preview", "/api/video/generate"]) {
      const response = await post(route, { projectId: project.id, generationId: unvoicedGeneration.id });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /voix de cette génération/);
    }
    assert.deepEqual(await getProject(), beforeUnvoiced, "a draft must not silently use another generation's voice");
  } finally {
    releaseVoice();
    await stop();
    tts.closeAllConnections();
    await new Promise<void>(resolve => tts.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
