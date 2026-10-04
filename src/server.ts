import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { config } from "./config.js";
import { ComfyClient } from "./comfy.js";
import { TtsClient } from "./tts.js";
import { GeneratorService } from "./generation.js";
import { assembleWanVideo, checkWanTransitions, createSegmentVideo, detectSilences, mediaHealth, probeDuration } from "./media.js";
import { voicePresets, getVoicePreset } from "./voicePresets.js";
import { AvatarStore, type AvatarGeneration, type AvatarProject, type ProjectJob, type ShortAsset, type VoiceAsset, type VideoAsset } from "./avatarStore.js";
import { BatchStore, type BatchRun, type BatchVideoSettings } from "./batchStore.js";
import { createYouTubeShort, parseShortOptions, shortMakerHealth } from "./shortMaker.js";
import { buildWanS2VExtendedWorkflow, buildWanS2VSilenceAwareWorkflow, buildWanS2VStabilizedWorkflow, parseWanStabilizationSeconds, planWanS2VSilenceWindows, planWanS2VWindows, WAN_S2V_MODELS, WAN_S2V_NODES, WAN_S2V_STABLE_NODES, WAN_S2V_CHUNK_FRAMES, WAN_S2V_FPS, WAN_S2V_STABILIZATION_SECONDS } from "./wanS2V.js";
import { availableBenchmarkWorkers, executeBenchmark, parseBenchmarkWorkers, type BenchmarkRun } from "./benchmark.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");

// IMPORTANT : les données sont volontairement HORS du code de l'application.
// Une nouvelle version du ZIP peut donc remplacer tout le dossier de code sans
// effacer les avatars, WAV et vidéos déjà générés.
const dataRoot = path.resolve(
  process.env.DGX_AVATAR_DATA_DIR?.trim() || path.join(os.homedir(), "dgx-avatar-studio-data")
);
const projectRoot = path.join(dataRoot, "projects");
const transientRoot = path.join(dataRoot, "work");
await fs.mkdir(projectRoot, { recursive: true });
await fs.mkdir(transientRoot, { recursive: true });

const benchmarkRoot = path.join(dataRoot, "benchmarks");
const benchmarkLogsDir = path.join(benchmarkRoot, "logs");
const benchmarkOutputsDir = path.join(benchmarkRoot, "outputs");
await fs.mkdir(benchmarkLogsDir, { recursive: true });
await fs.mkdir(benchmarkOutputsDir, { recursive: true });
const benchmarkRuns = new Map<string, BenchmarkRun>();

const app = express();
const port = Number(process.env.PORT || 3010);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const comfy = new ComfyClient();
const tts = new TtsClient();
const generator = new GeneratorService(transientRoot, comfy, tts);
const store = new AvatarStore(projectRoot);
await store.init();
const batchStore = new BatchStore(dataRoot);
await batchStore.init();
const activeControllers = new Map<string, AbortController>();
const batchControllers = new Map<string, AbortController>();

const VOICE_FINGERPRINT_TEXT = "Bonjour. Cette voix est la signature de mon avatar. Elle restera naturelle, claire et coherente dans toutes mes prochaines narrations.";

app.use(express.json({ limit: "4mb" }));
app.use(express.static(publicDir, { index: "studio.html" }));
app.use("/projects", express.static(projectRoot));

function pub(projectId: string, folder: string, filename: string): string {
  return `/project-files/${encodeURIComponent(projectId)}/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
}
function n(v: unknown, fallback: number): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}
function projectOrThrow(id: unknown) {
  const project = store.get(String(id || ""));
  if (!project) throw new Error("Projet inconnu. Crée ou recharge un projet.");
  return project;
}

function generationOrThrow(project: AvatarProject, id: unknown): AvatarGeneration {
  const generation = (project.generations || []).find(item => item.id === String(id || ""));
  if (!generation) throw new Error("Generation inconnue pour cet avatar.");
  return generation;
}

function createAvatarGeneration(project: AvatarProject, nameValue: unknown, textValue: unknown, batchId?: string): AvatarGeneration {
  const name = s(nameValue);
  const text = s(textValue);
  if (!name) throw new Error("Le nom de la generation est obligatoire.");
  if (!text) throw new Error("Le texte a lire est vide.");
  const now = Date.now();
  const generation: AvatarGeneration = {
    id: randomUUID(), name: name.slice(0, 120), text, createdAt: now, updatedAt: now,
    status: "draft", batchId
  };
  project.generations = [generation, ...(project.generations || [])];
  return generation;
}

function nextVideoRevision(project: AvatarProject, source: AvatarGeneration): AvatarGeneration {
  const baseName = source.name.replace(/ — vidéo \d+$/i, "");
  const names = new Set((project.generations || []).map(item => item.name));
  let revision = 2;
  while (names.has(`${baseName} — vidéo ${revision}`)) revision++;
  const now = Date.now();
  const generation: AvatarGeneration = {
    id: randomUUID(), name: `${baseName} — vidéo ${revision}`.slice(0, 120), text: source.text,
    createdAt: now, updatedAt: now, status: "video-running", voice: source.voice || project.voice,
    batchId: source.batchId
  };
  project.generations = [generation, ...(project.generations || [])];
  return generation;
}

function abortMessage(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /arret|arrêt|abort|interromp/i.test(error.message));
}
async function copyAsset(source: string, target: string): Promise<void> {
  if (path.resolve(source) !== path.resolve(target)) await fs.copyFile(source, target);
}

function s(value: unknown): string {
  return String(value ?? "").trim();
}

function rawAvatarPrompt(body: Record<string, any>): string {
  const prompt = s(body.prompt);
  if (!prompt) throw new Error("Décris l'image à générer.");
  return prompt;
}

type ImageQuality = "fast" | "normal" | "final";

function imageQualitySettings(value: unknown): { profile: ImageQuality; steps: number; width: number; height: number; defaultStrictReset: boolean } {
  const profile: ImageQuality = value === "fast" || value === "final" ? value : "normal";
  if (profile === "fast") return { profile, steps: 12, width: 1104, height: 1472, defaultStrictReset: false };
  if (profile === "final") return { profile, steps: 32, width: 1104, height: 1472, defaultStrictReset: true };
  return { profile, steps: 20, width: 1104, height: 1472, defaultStrictReset: false };
}

type VideoQuality = "fast" | "normal" | "final";
type VideoStrategy = "auto" | "continuous" | "long" | "safe";

function videoQualitySettings(value: unknown): {
  profile: VideoQuality;
  width: number;
  height: number;
  steps: number;
  cfg: number;
} {
  const profile: VideoQuality = value === "fast" || value === "final" ? value : "normal";
  if (profile === "fast") return { profile, width: 512, height: 288, steps: 12, cfg: 5.5 };
  if (profile === "final") return { profile, width: 832, height: 480, steps: 28, cfg: 6 };
  return { profile, width: 768, height: 432, steps: 20, cfg: 6 };
}

type VideoSourceMode = "strict" | "creative";
type VideoFramingMode = "original" | "fit" | "crop";

async function prepareWanReferenceImage(
  sourcePath: string,
  targetPath: string,
  width: number,
  height: number,
  framing: VideoFramingMode
): Promise<void> {
  if (framing === "original") {
    // Strict/default path: preserve the user's image pixels and dimensions.
    // WanSoundImageToVideo receives the original image; no resize/crop/sharpen here.
    await fs.copyFile(sourcePath, targetPath);
    return;
  }

  const image = sharp(sourcePath).rotate();
  if (framing === "crop") {
    await image
      .resize(width, height, { fit: "cover", position: "centre", kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 6 })
      .toFile(targetPath);
    return;
  }

  // fit = preserve the complete source image; padding is added only to reach
  // the requested video canvas. Black padding is deterministic and does not
  // alter the source content.
  await image
    .resize(width, height, {
      fit: "contain",
      position: "centre",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
      kernel: sharp.kernel.lanczos3
    })
    .png({ compressionLevel: 6 })
    .toFile(targetPath);
}

function chooseVideoStrategy(totalSeconds: number, requested: unknown): { requested: VideoStrategy; used: Exclude<VideoStrategy, "auto">; chunkSeconds: number } {
  const requestedMode: VideoStrategy =
    requested === "continuous" || requested === "long" || requested === "safe" || requested === "auto"
      ? requested
      : "auto";

  if (requestedMode === "continuous") {
    // Continuous mode was causing strong face drift on long one-shot generations.
    // Keep the same original avatar as an identity anchor and internally split the
    // render into stabilized blocks of at most 8 seconds.
    return { requested: requestedMode, used: "continuous", chunkSeconds: Math.min(Math.max(1, totalSeconds), 8) };
  }
  if (requestedMode === "long") {
    return { requested: requestedMode, used: "long", chunkSeconds: Math.min(Math.max(1, totalSeconds), 20) };
  }
  if (requestedMode === "safe") {
    return { requested: requestedMode, used: "safe", chunkSeconds: Math.min(Math.max(1, totalSeconds), 8) };
  }

  // Auto, version optimisée pour DGX Spark 128 Go : on pousse le continu plus loin.
  if (totalSeconds <= 18) return { requested: requestedMode, used: "continuous", chunkSeconds: Math.min(Math.max(1, totalSeconds), 8) };
  if (totalSeconds <= 90) return { requested: requestedMode, used: "long", chunkSeconds: 20 };
  return { requested: requestedMode, used: "safe", chunkSeconds: 8 };
}

function boolValue(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === 1 || value === "1" || value === "on";
}

function activeJob(project: AvatarProject): ProjectJob | undefined {
  const job = project.currentJob;
  return job && (job.status === "queued" || job.status === "running") ? job : undefined;
}

async function createProjectJob(
  project: AvatarProject,
  type: ProjectJob["type"],
  message: string,
  meta: Pick<ProjectJob, "generationId" | "batchId"> = {}
): Promise<ProjectJob> {
  const existing = activeJob(project);
  if (existing) throw new Error(`Une génération est déjà en cours : ${existing.message}`);
  const job: ProjectJob = {
    id: randomUUID(),
    type,
    status: "queued",
    createdAt: Date.now(),
    progress: 0,
    message,
    ...meta
  };
  project.currentJob = job;
  await store.save(project);
  return job;
}

async function updateProjectJob(project: AvatarProject, patch: Partial<ProjectJob>): Promise<void> {
  if (!project.currentJob) return;
  project.currentJob = { ...project.currentJob, ...patch };
  await store.save(project);
}

async function finishProjectJob(project: AvatarProject, patch: Partial<ProjectJob> = {}): Promise<void> {
  if (!project.currentJob) return;
  const finished: ProjectJob = {
    ...project.currentJob,
    ...patch,
    status: patch.status ?? "done",
    progress: patch.progress ?? (patch.status === "error" ? project.currentJob.progress : 100),
    finishedAt: Date.now()
  };
  project.currentJob = finished;
  project.jobHistory = [finished, ...(project.jobHistory || []).filter(j => j.id !== finished.id)].slice(0, 20);
  activeControllers.delete(finished.id);
  await store.save(project);
}

function controllerFor(job: ProjectJob): AbortController {
  const controller = new AbortController();
  activeControllers.set(job.id, controller);
  return controller;
}

function runDetached(task: () => Promise<void>): void {
  void task().catch(error => console.error("[job] erreur non gérée:", error));
}

function benchmarkNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function estimateRemainingSeconds(startedAt: number | undefined, progress: number): number | undefined {
  if (!startedAt || progress <= 0) return undefined;
  const elapsed = (Date.now() - startedAt) / 1000;
  const totalEstimate = elapsed / (progress / 100);
  const remaining = Math.max(0, totalEstimate - elapsed);
  return Number.isFinite(remaining) ? Math.round(remaining) : undefined;
}

app.get("/api/status", async (_req, res) => {
  const [comfyStatus, ttsStatus, ffmpeg, wanNodes] = await Promise.all([
    comfy.health(),
    tts.health(),
    mediaHealth(),
    comfy.hasNodes([...WAN_S2V_NODES])
  ]);
  let wanModels = { ok: false, missing: Object.values(WAN_S2V_MODELS) as string[] };
  try {
    const info = await comfy.nodeInfo();
    // ComfyUI's object_info schema varies slightly between node versions.
    // Do not assume that a model selector is always required[input][0].
    // Validate each expected model by searching the corresponding node metadata.
    const nodeHasModel = (node: string, model: string): boolean =>
      JSON.stringify(info?.[node] ?? {}).includes(`"${model}"`);
    const missing = [
      nodeHasModel("UNETLoader", WAN_S2V_MODELS.diffusion) ? null : WAN_S2V_MODELS.diffusion,
      nodeHasModel("CLIPLoader", WAN_S2V_MODELS.textEncoder) ? null : WAN_S2V_MODELS.textEncoder,
      nodeHasModel("AudioEncoderLoader", WAN_S2V_MODELS.audioEncoder) ? null : WAN_S2V_MODELS.audioEncoder,
      nodeHasModel("VAELoader", WAN_S2V_MODELS.vae) ? null : WAN_S2V_MODELS.vae
    ].filter(Boolean) as string[];
    wanModels = { ok: missing.length === 0, missing };
  } catch {}
  res.json({ comfy: comfyStatus, tts: ttsStatus, ffmpeg, dataRoot, wanS2V: { nodes: wanNodes, models: wanModels } });
});

app.get("/api/voice-presets", (_req, res) => res.json(voicePresets));

app.get("/api/projects", (_req, res) => {
  res.json({ projects: store.list() });
});

app.post("/api/project", async (req, res) => {
  try {
    const requestedName = s(req.body?.name);
    if (!requestedName) return res.status(400).json({ error: "Le nom du projet est obligatoire." });
    const project = await store.create(requestedName);
    res.json({ project });
  }
  catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.patch("/api/project/:id/name", async (req, res) => {
  try {
    const project = projectOrThrow(req.params.id);
    const name = s(req.body?.name);
    if (!name) throw new Error("Le nom du projet est vide.");
    await store.rename(project, name);
    res.json({ project });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/project/:id", (req, res) => {
  try { res.json({ project: projectOrThrow(req.params.id) }); }
  catch (e) { res.status(404).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.delete("/api/project/:id/generations/:generationId", async (req, res) => {
  try {
    const project = projectOrThrow(req.params.id);
    const job = activeJob(project);
    if (job) {
      return res.status(409).json({ error: "Attends la fin de la generation en cours ou arrete-la avant de supprimer un historique." });
    }
    const usedByActiveBatch = batchStore.list().some(batch =>
      (batch.status === "queued" || batch.status === "running" || batch.status === "stopping") &&
      batch.items.some(item => item.generationId === req.params.generationId)
    );
    if (usedByActiveBatch) {
      return res.status(409).json({ error: "Cette generation est utilisee par un batch en cours. Arrete d'abord le batch." });
    }
    const removed = await store.removeGeneration(project, req.params.generationId);
    res.json({ project, deletedGeneration: { id: removed.id, name: removed.name } });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/project/:id", async (req, res) => {
  try {
    const project = projectOrThrow(req.params.id);
    if (activeJob(project)) {
      return res.status(409).json({ error: "Arrete la generation en cours avant de supprimer cet avatar." });
    }
    const usedByActiveBatch = batchStore.list().some(batch =>
      (batch.status === "queued" || batch.status === "running" || batch.status === "stopping") &&
      batch.items.some(item => item.avatarId === project.id && item.status !== "done" && item.status !== "error")
    );
    if (usedByActiveBatch) {
      return res.status(409).json({ error: "Cet avatar est encore utilise par un batch en cours. Arrete d'abord le batch." });
    }
    await store.archive(project);
    res.json({ deleted: true, avatar: { id: project.id, name: project.name }, recoverable: true });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/project/:id/generations", async (req, res) => {
  try {
    const project = projectOrThrow(req.params.id);
    const generation = createAvatarGeneration(project, req.body?.name, req.body?.text);
    await store.save(project);
    res.status(201).json({ project, generation });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/project-files/:id/:folder/:filename", async (req, res) => {
  try {
    const project = projectOrThrow(req.params.id);
    const folder = String(req.params.folder || "");
    if (!(["avatar", "voice", "video"] as string[]).includes(folder)) return res.status(400).end();
    const filename = path.basename(String(req.params.filename || ""));
    if (!filename) return res.status(400).end();
    const target = path.join(store.base(project), folder, filename);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.resolve(target));
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Route dédiée pour l'aperçu avatar : évite les problèmes de cache ou de chemin
// avec la route statique /projects. Le fichier est toujours celui du projet courant.
app.get("/api/avatar/file/:id", async (req, res) => {
  try {
    const project = projectOrThrow(req.params.id);
    if (!project.avatar) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.type("png");
    res.sendFile(path.resolve(project.avatar.path));
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/avatar/generate", async (req, res) => {
  try {
    const project = projectOrThrow(req.body.projectId);
    const finalPrompt = rawAvatarPrompt(req.body as Record<string, any>);
    const userPrompt = finalPrompt;
    const seedRaw = n(req.body.seed, -1);
    const seed = seedRaw >= 0 ? Math.floor(seedRaw) : Math.floor(Math.random() * 1_000_000_000);
    const quality = imageQualitySettings(req.body.quality);
    const width = Math.floor(n(req.body.width, quality.width));
    const height = Math.floor(n(req.body.height, quality.height));
    const customSteps = Math.floor(n(req.body.steps, quality.steps));
    const steps = Math.max(4, Math.min(60, customSteps));
    const strictReset = boolValue(req.body.strictReset, quality.defaultStrictReset);
    const job = await createProjectJob(project, "image", "Génération de l'image en attente…");
    const controller = controllerFor(job);

    runDetached(async () => {
      try {
        await updateProjectJob(project, { status: "running", startedAt: Date.now(), progress: 5, message: "Génération de l'image avec Qwen-Image…" });
        if (strictReset) await comfy.resetImageSession(controller.signal);
        let generated;
        try {
          generated = await generator.generateImage({
            scenePrompt: finalPrompt,
            text: "",
            textMode: "exact",
            width,
            height,
            seed,
            textPosition: "bottom",
            fontSize: 32,
            upscaleFactor: 1,
            fastPreview: false,
            steps,
            refineQuality: false,
            imageModel: "bf16",
            visualPreset: "none"
          }, { signal: controller.signal });
        } finally {
          if (strictReset) await comfy.resetImageSession().catch(() => undefined);
        }
        await updateProjectJob(project, { progress: 90, message: "Enregistrement de l'image…" });
        const base = await store.ensure(project);
        const filename = "avatar.png";
        const target = path.join(base, "avatar", filename);
        await copyAsset(generated.path, target);
        project.avatar = {
          name: filename,
          path: target,
          url: pub(project.id, "avatar", filename),
          source: "generated",
          prompt: userPrompt,
          builtPrompt: finalPrompt,
          seed,
          generation: { quality: quality.profile, steps, width, height, strictReset }
        };
        project.video = undefined;
        await finishProjectJob(project, { message: "Image terminée.", progress: 100 });
      } catch (error) {
        await finishProjectJob(project, { status: abortMessage(error) ? "interrupted" : "error", progress: project.currentJob?.progress || 0, message: abortMessage(error) ? "Generation de l'image arretee." : "Erreur pendant la génération de l'image.", error: error instanceof Error ? error.message : String(error) });
      }
    });

    res.status(202).json({ project, job });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/avatar/upload", upload.single("avatar"), async (req, res) => {
  try {
    const project = projectOrThrow(req.body.projectId);
    if (!req.file) throw new Error("Image manquante.");
    if (!req.file.mimetype.startsWith("image/")) throw new Error("Le fichier doit être une image.");
    const base = await store.ensure(project);
    const filename = "avatar.png";
    const target = path.join(base, "avatar", filename);
    const png = await sharp(req.file.buffer).rotate().png({ compressionLevel: 6 }).toBuffer();
    await fs.writeFile(target, png);
    project.avatar = { name: filename, path: target, url: pub(project.id, "avatar", filename), source: "uploaded" };
    project.video = undefined;
    await store.save(project);
    res.json({ project, avatar: project.avatar });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/voice/fingerprint", async (req, res) => {
  try {
    const project = projectOrThrow(req.body.projectId);
    if (!project.avatar) throw new Error("Genere ou charge d'abord un avatar.");
    const refText = s(req.body.refText) || VOICE_FINGERPRINT_TEXT;
    const presetId = String(req.body.voicePreset || "narrator");
    const preset = getVoicePreset(presetId);
    const voicePrompt = s(req.body.voicePrompt) || preset.prompt;
    const voiceSeed = Math.floor(n(req.body.voiceSeed, 123456));
    const job = await createProjectJob(project, "voice-fingerprint", "Creation de l'empreinte vocale en attente…");
    const controller = controllerFor(job);

    runDetached(async () => {
      try {
        await updateProjectJob(project, { status: "running", startedAt: Date.now(), progress: 5, message: "Creation de la voix de reference Qwen3-TTS…" });
        const audio = await generator.generateVoice({
          voiceText: refText,
          voicePrompt,
          voicePresetId: presetId,
          voiceLanguage: String(req.body.language || "French"),
          voiceSpeed: n(req.body.speed, 1),
          voiceSeed
        }, { signal: controller.signal });
        await updateProjectJob(project, { progress: 92, message: "Enregistrement de l'empreinte vocale…" });
        const base = await store.ensure(project);
        const filename = "voice-fingerprint.wav";
        const target = path.join(base, "voice", filename);
        await copyAsset(audio.path, target);
        project.voiceFingerprint = {
          name: filename,
          path: target,
          url: pub(project.id, "voice", filename),
          duration: audio.duration,
          refText,
          presetId,
          voicePrompt,
          seed: voiceSeed,
          createdAt: Date.now()
        };
        await finishProjectJob(project, { message: `Empreinte vocale prete (${audio.duration.toFixed(1)} s).`, progress: 100 });
      } catch (error) {
        await finishProjectJob(project, {
          status: abortMessage(error) ? "interrupted" : "error",
          progress: project.currentJob?.progress || 0,
          message: abortMessage(error) ? "Creation de l'empreinte arretee." : "Erreur pendant la creation de l'empreinte vocale.",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    res.status(202).json({ project, job });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/voice/generate", async (req, res) => {
  try {
    const project = projectOrThrow(req.body.projectId);
    const text = String(req.body.text || "").trim();
    if (!text) throw new Error("Le texte à lire est vide.");
    const wantsGeneration = Boolean(req.body.generationId || s(req.body.generationName));
    if (activeJob(project)) throw new Error(`Une generation est deja en cours : ${project.currentJob?.message}`);
    if (wantsGeneration && !project.voiceFingerprint) {
      throw new Error("Cree d'abord l'empreinte vocale de cet avatar.");
    }
    let generation: AvatarGeneration | undefined;
    if (req.body.generationId) {
      generation = generationOrThrow(project, req.body.generationId);
      generation.text = text;
      generation.updatedAt = Date.now();
    } else if (s(req.body.generationName)) {
      generation = createAvatarGeneration(project, req.body.generationName, text, s(req.body.batchId) || undefined);
    }
    const presetId = generation ? project.voiceFingerprint!.presetId : String(req.body.voicePreset || "narrator");
    const preset = getVoicePreset(presetId);
    const voicePrompt = generation ? project.voiceFingerprint!.voicePrompt : (String(req.body.voicePrompt || "").trim() || preset.prompt);
    const voiceSeedRaw = n(req.body.voiceSeed, 123456);
    const job = await createProjectJob(project, "voice", "Generation de la voix en attente…", {
      generationId: generation?.id,
      batchId: s(req.body.batchId) || undefined
    });
    const controller = controllerFor(job);
    if (generation) generation.status = "voice-running";
    await store.save(project);

    runDetached(async () => {
      try {
        await updateProjectJob(project, { status: "running", startedAt: Date.now(), progress: 5, message: "Génération Qwen3-TTS…" });
        const audio = await generator.generateVoice({
          voiceText: text,
          voicePrompt,
          voicePresetId: presetId,
          voiceLanguage: String(req.body.language || "French"),
          voiceSpeed: n(req.body.speed, 1),
          voiceSeed: Math.floor(voiceSeedRaw),
          voiceReference: generation ? {
            id: `avatar-${project.id}`,
            audioPath: project.voiceFingerprint!.path,
            refText: project.voiceFingerprint!.refText,
            presetId: project.voiceFingerprint!.presetId
          } : undefined
        }, {
          signal: controller.signal,
          onVoiceProgress: event => {
            const ratio = event.total > 0 ? event.completed / event.total : 0;
            void updateProjectJob(project, {
              progress: Math.max(5, Math.min(90, Math.round(10 + ratio * 80))),
              current: event.completed,
              total: event.total,
              message: event.message
            });
          }
        });
        await updateProjectJob(project, { progress: 92, message: "Enregistrement de la voix…" });
        const base = await store.ensure(project);
        const filename = generation ? `speech-${generation.id}.wav` : "speech.wav";
        const target = path.join(base, "voice", filename);
        await copyAsset(audio.path, target);
        const voice: VoiceAsset = {
          name: filename,
          path: target,
          url: pub(project.id, "voice", filename),
          duration: audio.duration,
          text,
          presetId,
          voicePrompt,
          seed: Math.floor(voiceSeedRaw)
        };
        project.voice = voice;
        project.video = undefined;
        if (generation) {
          const obsoleteShort = generation.short?.path;
          generation.voice = voice;
          generation.video = undefined;
          generation.short = undefined;
          generation.shortError = undefined;
          generation.status = "voice-ready";
          generation.error = undefined;
          generation.updatedAt = Date.now();
          if (obsoleteShort) await fs.rm(obsoleteShort, { force: true }).catch(() => undefined);
        }
        await finishProjectJob(project, { message: `Voix terminée (${audio.duration.toFixed(1)} s).`, progress: 100 });
      } catch (error) {
        if (generation) {
          generation.status = abortMessage(error) ? "stopped" : "error";
          generation.error = error instanceof Error ? error.message : String(error);
          generation.updatedAt = Date.now();
        }
        await finishProjectJob(project, { status: abortMessage(error) ? "interrupted" : "error", progress: project.currentJob?.progress || 0, message: abortMessage(error) ? "Generation vocale arretee." : "Erreur pendant la generation de la voix.", error: error instanceof Error ? error.message : String(error) });
      }
    });

    res.status(202).json({ project, job, generation });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/benchmark/workers", async (_req, res) => {
  const configured = parseBenchmarkWorkers();
  const workers = await availableBenchmarkWorkers(configured);
  res.json({ configured, workers });
});

app.get("/api/benchmark/runs", async (_req, res) => {
  try {
    const files = (await fs.readdir(benchmarkLogsDir)).filter(name => name.endsWith(".json")).sort().reverse().slice(0, 30);
    const saved = await Promise.all(files.map(async name => {
      try { return JSON.parse(await fs.readFile(path.join(benchmarkLogsDir, name), "utf8")); }
      catch { return null; }
    }));
    const live = [...benchmarkRuns.values()].filter(r => r.status === "queued" || r.status === "running");
    res.json({ live, saved: saved.filter(Boolean) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/benchmark/runs/:id", (req, res) => {
  const run = benchmarkRuns.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Benchmark inconnu." });
  res.json(run);
});

app.post("/api/benchmark/run", upload.fields([{ name: "image", maxCount: 1 }, { name: "wav", maxCount: 1 }]), async (req, res) => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const image = files?.image?.[0];
    const wav = files?.wav?.[0];
    if (!image) throw new Error("Image manquante.");
    if (!wav) throw new Error("WAV manquant.");

    const comfyInputDir = process.env.COMFY_INPUT_DIR?.trim();
    if (!comfyInputDir) throw new Error("COMFY_INPUT_DIR n'est pas configuré dans .env.");
    await fs.mkdir(comfyInputDir, { recursive: true });

    const id = randomUUID();
    const imageExt = path.extname(image.originalname) || ".png";
    const imageInputName = `benchmark-${id}-image${imageExt}`;
    const wavInputName = `benchmark-${id}-audio.wav`;
    await fs.writeFile(path.join(comfyInputDir, imageInputName), image.buffer);
    await fs.writeFile(path.join(comfyInputDir, wavInputName), wav.buffer);

    const mode = req.body.mode === "parallel" ? "parallel" : "sequential";
    const concurrency = Math.round(benchmarkNumber(req.body.concurrency, 2, 1, 4));
    const totalJobs = Math.round(benchmarkNumber(req.body.totalJobs, 4, 1, 20));
    const workers = parseBenchmarkWorkers();
    const run: BenchmarkRun = {
      id,
      status: "queued",
      createdAt: Date.now(),
      mode,
      requestedConcurrency: mode === "sequential" ? 1 : concurrency,
      effectiveConcurrency: 0,
      totalJobs,
      completedJobs: 0,
      failedJobs: 0,
      progress: 0,
      imageName: image.originalname,
      wavName: wav.originalname,
      settings: {
        width: Math.round(benchmarkNumber(req.body.width, 768, 256, 1920)),
        height: Math.round(benchmarkNumber(req.body.height, 432, 256, 1080)),
        steps: Math.round(benchmarkNumber(req.body.steps, 20, 4, 60)),
        cfg: benchmarkNumber(req.body.cfg, 6, 1, 12),
        seed: Math.round(benchmarkNumber(req.body.seed, 123456, 0, 2147483647)),
        strictIdentity: req.body.strictIdentity !== "false"
      },
      workers,
      results: [],
      message: "Benchmark en attente…"
    };
    benchmarkRuns.set(id, run);

    runDetached(async () => {
      try {
        await executeBenchmark({
          run,
          imageInputName,
          wavInputName,
          logsDir: benchmarkLogsDir,
          outputsDir: benchmarkOutputsDir,
          onUpdate: updated => { benchmarkRuns.set(updated.id, updated); }
        });
      } catch (error) {
        run.status = "error";
        run.finishedAt = Date.now();
        run.globalDurationMs = run.startedAt ? run.finishedAt - run.startedAt : undefined;
        run.error = error instanceof Error ? error.message : String(error);
        run.message = "Benchmark interrompu par une erreur.";
        const logFile = path.join(benchmarkLogsDir, `${new Date(run.createdAt).toISOString().replace(/[:.]/g, "-")}-${run.id}.json`);
        run.logFile = logFile;
        await fs.writeFile(logFile, JSON.stringify(run, null, 2), "utf8").catch(() => undefined);
      }
    });

    res.status(202).json(run);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/video/preview", async (req, res) => {
  try {
    const project = projectOrThrow(req.body.projectId);
    const generation = req.body.generationId ? generationOrThrow(project, req.body.generationId) : undefined;
    const voice = generation?.voice || project.voice;
    if (!project.avatar) throw new Error("Génère ou charge d'abord un avatar.");
    if (!voice) throw new Error("Génère d'abord la voix.");
    const job = await createProjectJob(project, "video-preview", "Création de la vidéo test en attente…", { generationId: generation?.id });
    const controller = controllerFor(job);
    if (generation) generation.status = "video-running";
    await store.save(project);
    runDetached(async () => {
      try {
        await updateProjectJob(project, { status: "running", startedAt: Date.now(), progress: 10, message: "Création de la vidéo test avec FFmpeg…" });
        const base = await store.ensure(project);
        const filename = generation ? `preview-${generation.id}.mp4` : "avatar-preview.mp4";
        const target = path.join(base, "video", filename);
        const duration = await createSegmentVideo(project.avatar!.path, voice.path, target, controller.signal);
        const video: VideoAsset = { name: filename, path: target, url: pub(project.id, "video", filename), duration, engine: "preview" };
        project.video = video;
        if (generation) {
          const obsoleteShort = generation.short?.path;
          generation.video = video;
          generation.short = undefined;
          generation.shortError = undefined;
          generation.status = "done";
          generation.error = undefined;
          generation.updatedAt = Date.now();
          if (obsoleteShort) await fs.rm(obsoleteShort, { force: true }).catch(() => undefined);
        }
        await finishProjectJob(project, { message: "Vidéo test terminée.", progress: 100 });
      } catch (error) {
        if (generation) {
          generation.status = abortMessage(error) ? "stopped" : "error";
          generation.error = error instanceof Error ? error.message : String(error);
          generation.updatedAt = Date.now();
        }
        await finishProjectJob(project, { status: abortMessage(error) ? "interrupted" : "error", message: abortMessage(error) ? "Video test arretee." : "Erreur pendant la vidéo test.", error: error instanceof Error ? error.message : String(error) });
      }
    });
    res.status(202).json({ project, job });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/video/generate", async (req, res) => {
  try {
    const project = projectOrThrow(req.body.projectId);
    if (req.body.engine && req.body.engine !== "wan-s2v") throw new RangeError("Seul Wan2.2-S2V + Extend est disponible.");
    let generation = req.body.generationId ? generationOrThrow(project, req.body.generationId) : undefined;
    const voice = generation?.voice || project.voice;
    if (!project.avatar) throw new Error("Génère ou charge d'abord un avatar.");
    if (!voice) throw new Error("Génère d'abord la voix.");

    // A video already in history is immutable: re-render into a fresh entry
    // with a new asset filename so both versions remain accessible.
    if (generation?.video) generation = nextVideoRevision(project, generation);

    const engine = "wan-s2v" as const;
    const engineLabel = "Wan2.2-S2V + Extend";
    const upscale = false;

    // New renders use only native Wan Extend; legacy engine types remain in
    // stored history so old videos continue to display correctly.
    const stabilized = false;
    const resetOnSilence = false;
    const stabilizationSeconds = WAN_S2V_STABILIZATION_SECONDS;
    const continuity = "continuous" as const;
    const job = await createProjectJob(project, "video-wan", `Génération ${engineLabel} en attente…`, {
      generationId: generation?.id,
      batchId: s(req.body.batchId) || undefined
    });
    const controller = controllerFor(job);
    project.videoSettings = { engine, upscale, continuity, ...(stabilized ? { stabilizationSeconds } : {}) };
    if (generation) {
      generation.status = "video-running";
      generation.videoSettings = {
        engine,
        upscale,
        quality: req.body.quality === "fast" || req.body.quality === "final" ? req.body.quality : "normal",
        continuity,
        ...(stabilized ? { stabilizationSeconds } : {}),
        sourceMode: req.body.sourceMode === "creative" ? "creative" : "strict",
        framing: req.body.framing === "fit" || req.body.framing === "crop" ? req.body.framing : "original",
        motionPrompt: s(req.body.motionPrompt),
        width: Math.floor(n(req.body.width, videoQualitySettings(req.body.quality).width)),
        height: Math.floor(n(req.body.height, videoQualitySettings(req.body.quality).height)),
        steps: Math.max(4, Math.min(60, Math.floor(n(req.body.steps, videoQualitySettings(req.body.quality).steps)))),
        cfg: n(req.body.cfg, videoQualitySettings(req.body.quality).cfg),
        seed: Math.floor(n(req.body.seed, 123456))
      };
    }
    await store.save(project);

    runDetached(async () => {
      const tempFiles: string[] = [];
      try {
        await updateProjectJob(project, {
          status: "running",
          startedAt: Date.now(),
          progress: 2,
          doneSeconds: 0,
          totalSeconds: 0,
          etaSeconds: undefined,
          message: "Vérification de Wan2.2-S2V Extend…"
        });

        const nodeCheck = await comfy.hasNodes([...WAN_S2V_NODES]);
        if (!nodeCheck.ok) {
          throw new Error(`Node(s) ComfyUI manquant(s) : ${nodeCheck.missing.join(", ")}. Mets ComfyUI à jour pour utiliser ce mode vidéo.`);
        }

        const info = await comfy.nodeInfo();
        const nodeHasModel = (node: string, model: string): boolean => JSON.stringify(info?.[node] ?? {}).includes(`"${model}"`);
        const missingModels = [
          nodeHasModel("UNETLoader", WAN_S2V_MODELS.diffusion) ? null : WAN_S2V_MODELS.diffusion,
          nodeHasModel("CLIPLoader", WAN_S2V_MODELS.textEncoder) ? null : WAN_S2V_MODELS.textEncoder,
          nodeHasModel("AudioEncoderLoader", WAN_S2V_MODELS.audioEncoder) ? null : WAN_S2V_MODELS.audioEncoder,
          nodeHasModel("VAELoader", WAN_S2V_MODELS.vae) ? null : WAN_S2V_MODELS.vae
        ].filter(Boolean) as string[];
        if (missingModels.length) throw new Error(`Modèle(s) Wan2.2-S2V manquant(s) : ${missingModels.join(", ")}.`);

        const comfyInputDir = process.env.COMFY_INPUT_DIR?.trim();
        if (!comfyInputDir) throw new Error("COMFY_INPUT_DIR n'est pas configuré dans .env.");
        await fs.mkdir(comfyInputDir, { recursive: true });

        const videoQuality = videoQualitySettings(req.body.quality);
        const total = voice.duration || await probeDuration(voice.path, controller.signal);
        const requestedWidth = Math.floor(n(req.body.width, videoQuality.width));
        const requestedHeight = Math.floor(n(req.body.height, videoQuality.height));
        const steps = Math.max(4, Math.min(60, Math.floor(n(req.body.steps, videoQuality.steps))));
        const cfg = n(req.body.cfg, videoQuality.cfg);
        const seed = Math.floor(n(req.body.seed, 123456));

        const sourceMode: VideoSourceMode = req.body.sourceMode === "creative" ? "creative" : "strict";
        const framing: VideoFramingMode =
          req.body.framing === "fit" || req.body.framing === "crop" ? req.body.framing : "original";

        const silences = resetOnSilence
          ? await detectSilences(voice.path, controller.signal, 0.20, -38)
          : undefined;
        const plannedWindows = stabilized
          ? (resetOnSilence
            ? planWanS2VSilenceWindows(total, silences || [], stabilizationSeconds)
            : planWanS2VWindows(total, stabilizationSeconds))
          : undefined;
        const silenceResetCount = plannedWindows?.filter((window, index) => index > 0 && window.resetToOriginal).length || 0;
        const totalFrames = Math.max(1, Math.ceil(total * WAN_S2V_FPS));
        const chunks = plannedWindows
          ? plannedWindows.reduce((sum, window) => sum + Math.ceil(window.frames / WAN_S2V_CHUNK_FRAMES), 0)
          : Math.max(1, Math.ceil(totalFrames / WAN_S2V_CHUNK_FRAMES));
        if (!info.WanSoundImageToVideo?.input?.optional?.control_video) {
          throw new Error("Cette version de ComfyUI ne propose pas control_video pour Wan2.2-S2V. Mets ComfyUI à jour pour verrouiller l'image de depart de chaque bloc.");
        }
        if (plannedWindows && plannedWindows.length > 1) {
          const missing = WAN_S2V_STABLE_NODES.filter(name => !info[name]);
          if (missing.length) {
            throw new Error(`Node(s) ComfyUI manquant(s) : ${missing.join(", ")}. Mets ComfyUI à jour pour utiliser les raccords stabilisés.`);
          }
          if (!info.WanSoundImageToVideo?.input?.optional?.ref_motion) {
            throw new Error("Cette version de ComfyUI ne propose pas ref_motion pour Wan2.2-S2V. Mets ComfyUI à jour pour reprendre la pose entre les blocs stabilisés.");
          }
          await checkWanTransitions();
        }

        await updateProjectJob(project, {
          progress: 6,
          totalSeconds: total,
          doneSeconds: 0,
          current: 1,
          total: chunks,
          message: resetOnSilence
            ? `Test Wan2.2 : ${silenceResetCount} reprise(s) sur silence détecté(s), ${chunks} passe(s) au total…`
            : `Wan2.2 natif : ${chunks} passe(s) de ${WAN_S2V_CHUNK_FRAMES} frames pour ${total.toFixed(1)} s d'audio…`
        });

        const base = await store.ensure(project);
        const workDir = path.join(transientRoot, `wan-extend-${project.id}-${randomUUID()}`);
        await fs.mkdir(workDir, { recursive: true });
        tempFiles.push(workDir);

        // Image de référence : aucun traitement en mode Original.
        const sourceExt = path.extname(project.avatar!.path) || ".png";
        const imageExt = framing === "original" ? sourceExt : ".png";
        const imageName = `wan-avatar-${project.id}-${randomUUID()}${imageExt}`;
        const preparedImagePath = path.join(comfyInputDir, imageName);
        await prepareWanReferenceImage(
          project.avatar!.path,
          preparedImagePath,
          requestedWidth,
          requestedHeight,
          framing
        );

        // Un seul fichier WAV : le mode stabilisé en extrait les fenêtres dans
        // ComfyUI. Le WAV complet reste la piste audio finale dans les deux modes.
        const audioName = `wan-audio-full-${project.id}-${randomUUID()}.wav`;
        await fs.copyFile(voice.path, path.join(comfyInputDir, audioName));

        const userMotionPrompt = String(req.body.motionPrompt || "").trim();
        const prompt = sourceMode === "strict"
          ? "The same person with the exact original appearance from the reference image. Preserve the natural skin and beard texture, original lip color, lighting, contrast, clothing and background. Natural synchronized speech and a stable camera."
          : (userMotionPrompt || "The subject speaks naturally with synchronized mouth movement while keeping the camera stable and preserving the original appearance and background.");

        const workflowArgs = {
          imageName,
          audioName,
          prompt,
          strictIdentity: sourceMode === "strict",
          seed,
          width: requestedWidth,
          height: requestedHeight,
          durationSeconds: total,
          stabilizationSeconds,
          steps,
          cfg,
          filenamePrefix: `dgx-avatar/wan-extend-${project.id}`,
          chunkFrames: WAN_S2V_CHUNK_FRAMES
        };
        const { graph, generatedFrames, windows } = resetOnSilence
          ? buildWanS2VSilenceAwareWorkflow(workflowArgs, silences || [])
          : (stabilized ? buildWanS2VStabilizedWorkflow(workflowArgs) : buildWanS2VExtendedWorkflow(workflowArgs));

        // Évite de vider les poids et le cache à chaque nouvelle vidéo.
        // ComfyUI libère lui-même de la mémoire lorsque le workflow en a besoin.
        if (config.video.freeMemoryBeforeWan) await comfy.freeMemory(controller.signal).catch(() => undefined);
        await updateProjectJob(project, {
          progress: 10,
          current: 1,
          total: chunks,
          message: windows
            ? (resetOnSilence
              ? `Test Wan2.2 : ${silenceResetCount} reset(s) sur silence, autres raccords stabilisés (${stabilizationSeconds} s max)…`
              : `Calcul Wan2.2 : ${chunks} passe(s), reprise corrigée à chaque bloc natif (${stabilizationSeconds} s)…`)
            : `Calcul Wan2.2 : bloc initial + ${Math.max(0, chunks - 1)} extension(s) natives…`
        });

        const samplerNodeIds = Object.entries(graph)
          .filter(([, node]) => node.class_type === "KSampler")
          .map(([id]) => id)
          .sort((a, b) => Number(a) - Number(b));
        const conditioningNodeIds = samplerNodeIds.map(id => (graph[id].inputs.latent_image as [string, number])[0]);
        const decodeNodeIds = Object.entries(graph).filter(([, node]) => node.class_type === "VAEDecode").map(([id]) => id);
        const saveNodeId = Object.entries(graph).find(([, node]) => node.class_type === "SaveVideo")?.[0];
        // Suit chaque sampler, y compris lors d'une réutilisation du cache.
        const samplerFractions = new Map<string, number>();
        const sampledBlocks = () => [...samplerFractions.values()].reduce((sum, value) => sum + value, 0);
        // Ne compte qu'une fois le temps vidéo partagé par les chevauchements.
        const samplerSeconds = windows?.flatMap((window, i) => {
          const overlap = i ? windows[i - 1].startFrame + windows[i - 1].frames - window.startFrame : 0;
          return Array.from({ length: Math.ceil(window.frames / WAN_S2V_CHUNK_FRAMES) }, (_, j) =>
            Math.max(0, Math.min(window.frames, (j + 1) * WAN_S2V_CHUNK_FRAMES) - Math.max(overlap, j * WAN_S2V_CHUNK_FRAMES)) / WAN_S2V_FPS
          );
        });
        const sampledSeconds = () => samplerNodeIds.reduce((seconds, id, index) => seconds + (
          samplerFractions.get(id) === 1
            ? (samplerSeconds?.[index] ?? Math.max(0, Math.min(WAN_S2V_CHUNK_FRAMES / WAN_S2V_FPS, total - index * WAN_S2V_CHUNK_FRAMES / WAN_S2V_FPS)))
            : 0
        ), 0);

        let lastUiUpdateAt = 0;
        let lastUiProgress = 9;
        let updateChain = Promise.resolve();
        const pushProgress = (patch: Partial<ProjectJob>, force = false) => {
          const now = Date.now();
          const requestedProgress = Math.max(lastUiProgress, Number(patch.progress ?? lastUiProgress));
          if (!force && now - lastUiUpdateAt < 850 && Math.abs(requestedProgress - lastUiProgress) < 1) return;
          lastUiUpdateAt = now;
          lastUiProgress = requestedProgress;
          updateChain = updateChain
            .then(() => updateProjectJob(project, {
              ...patch,
              progress: requestedProgress,
              etaSeconds: estimateRemainingSeconds(project.currentJob?.startedAt, Math.max(1, requestedProgress))
            }))
            .catch(error => console.error("[Wan progress]", error));
        };

        const tracked = await comfy.queueTracked(graph, event => {
          const nodeId = event.node;
          if (!nodeId) return;

          const conditioningIndex = conditioningNodeIds.indexOf(nodeId);
          if (conditioningIndex >= 0 && event.type === "executing") {
            const current = conditioningIndex + 1;
            const reanchored = graph[nodeId].class_type === "WanSoundImageToVideo";
            pushProgress({
              progress: Math.min(79, Math.round(10 + 70 * sampledBlocks() / chunks)),
              current: Math.min(chunks, Math.floor(sampledBlocks()) + 1), total: chunks,
              doneSeconds: Math.min(total, sampledSeconds()), totalSeconds: total,
              message: reanchored
                ? (graph[nodeId].inputs.ref_motion
                  ? `Wan2.2 : bloc ${current}/${chunks}, depart verrouille sur la dernière image…`
                  : `Wan2.2 : bloc ${current}/${chunks} depuis l'image originale exacte…`)
                : `Wan2.2 : extension native ${current}/${chunks}…`
            }, true);
            return;
          }

          const samplerIndex = samplerNodeIds.indexOf(nodeId);
          if (samplerIndex >= 0 && event.type === "progress" && event.max && event.value !== undefined) {
            const fraction = Math.max(0, Math.min(1, event.value / event.max));
            samplerFractions.set(nodeId, Math.max(samplerFractions.get(nodeId) ?? 0, fraction));
            const progress = 10 + 70 * (sampledBlocks() / chunks);
            const doneSeconds = Math.min(total, sampledSeconds());
            pushProgress({
              progress: Math.min(79, Math.round(progress * 10) / 10),
              current: Math.max(1, Math.ceil(sampledBlocks())), total: chunks, doneSeconds, totalSeconds: total,
              message: `Wan2.2 : calcul du bloc ${samplerIndex + 1}/${chunks} — étape ${event.value}/${event.max}…`
            });
            return;
          }

          const decodeIndex = decodeNodeIds.indexOf(nodeId);
          if (decodeIndex >= 0 && event.type === "executing") {
            pushProgress({
              message: `Wan2.2 : décodage vidéo ${decodeIndex + 1}/${decodeNodeIds.length}…`
            }, true);
            return;
          }

          if (nodeId === saveNodeId && event.type === "executing") {
            pushProgress({
              progress: 94, current: chunks, total: chunks, doneSeconds: total, totalSeconds: total,
              message: "Wan2.2 : encodage et sauvegarde MP4…"
            }, true);
          }
        }, controller.signal);

        let ref;
        try {
          ref = await comfy.waitForFile(tracked.promptId, [".mp4", ".mkv", ".webm"], 0, controller.signal);
          await updateChain;
        } finally {
          tracked.close();
        }

        await updateProjectJob(project, {
          progress: 96,
          current: chunks,
          total: chunks,
          doneSeconds: total,
          totalSeconds: total,
          etaSeconds: 0,
          message: windows
            ? "Wan2.2 terminé. Adoucissement des raccords et assemblage avec l'audio original…"
            : `Wan2.2 terminé (${generatedFrames} frames calculées). Ajustement à la durée exacte du WAV…`
        });

        const bytes = await comfy.downloadFile(ref, controller.signal);
        const raw = path.join(workDir, "wan-extended-raw.mp4");
        await fs.writeFile(raw, bytes);

        const filename = generation ? `video-${generation.id}.mp4` : "avatar-speaking-wan2.2-extend.mp4";
        const target = path.join(base, "video", filename);
        // Fusionne les mêmes instants des fenêtres voisines, puis remet le WAV
        // original. Le mode continu garde sa simple coupe de fin habituelle.
        await assembleWanVideo(raw, voice.path, target, total, windows, preparedImagePath, controller.signal);

        const duration = await probeDuration(target, controller.signal).catch(() => total);
        const video: VideoAsset = {
          name: filename,
          path: target,
          url: pub(project.id, "video", filename),
          duration,
          engine: "wan-s2v",
          continuity,
          stabilizationSeconds: stabilized ? stabilizationSeconds : undefined
        };
        project.video = video;
        if (generation) {
          const obsoleteShort = generation.short?.path;
          generation.video = video;
          generation.short = undefined;
          generation.shortError = undefined;
          generation.status = "done";
          generation.error = undefined;
          generation.updatedAt = Date.now();
          if (obsoleteShort) await fs.rm(obsoleteShort, { force: true }).catch(() => undefined);
        }

        await finishProjectJob(project, {
          message: `Vidéo Wan2.2 Extend terminée (${duration.toFixed(1)} s, ${chunks} passe(s) natives).`,
          progress: 100,
          current: chunks,
          total: chunks,
          doneSeconds: duration,
          totalSeconds: total,
          etaSeconds: 0
        });
      } catch (error) {
        if (generation) {
          generation.status = abortMessage(error) ? "stopped" : "error";
          generation.error = error instanceof Error ? error.message : String(error);
          generation.updatedAt = Date.now();
        }
        await finishProjectJob(project, {
          status: abortMessage(error) ? "interrupted" : "error",
          message: abortMessage(error) ? `Génération ${engineLabel} arrêtée.` : `Erreur pendant la génération ${engineLabel}.`,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        for (const p of tempFiles) await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    res.status(202).json({ project, generation, job });
  } catch (e) {
    res.status(e instanceof RangeError ? 400 : 500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/short/status", async (_req, res) => {
  res.json(await shortMakerHealth());
});

app.post("/api/short/generate", async (req, res) => {
  try {
    const project = projectOrThrow(req.body.projectId);
    const generation = generationOrThrow(project, req.body.generationId);
    if (!generation.video) throw new Error("Genere d'abord la video de cette generation.");
    const sourceVideo = generation.video;
    const options = parseShortOptions(req.body);
    const job = await createProjectJob(project, "short", "Creation du Short YouTube en attente…", {
      generationId: generation.id,
      batchId: s(req.body.batchId) || undefined
    });
    const controller = controllerFor(job);
    generation.status = "short-running";
    generation.shortError = undefined;
    generation.updatedAt = Date.now();
    await store.save(project);

    runDetached(async () => {
      try {
        await updateProjectJob(project, {
          status: "running", startedAt: Date.now(), progress: 1,
          message: options.upscale ? "Preparation du Short avec upscale IA…" : "Preparation du Short YouTube…"
        });
        const base = await store.ensure(project);
        const filename = `short-${generation.id}.mp4`;
        const target = path.join(base, "video", filename);
        const workingTarget = path.join(base, "video", `.short-${generation.id}-${randomUUID()}.mp4`);
        let updateChain = Promise.resolve();
        const result = await createYouTubeShort(sourceVideo.path, workingTarget, options, {
          signal: controller.signal,
          onProgress: event => {
            updateChain = updateChain.then(() => updateProjectJob(project, {
              progress: Math.max(1, Math.min(99, Math.round(event.progress * 10) / 10)),
              message: event.message
            })).catch(error => console.error("[Short progress]", error));
          }
        });
        await updateChain;
        await fs.rename(workingTarget, target);
        const short: ShortAsset = {
          name: filename,
          path: target,
          url: pub(project.id, "video", filename),
          duration: result.duration,
          format: "youtube-short",
          width: 1080,
          height: 1920,
          framing: options.framing,
          upscaled: options.upscale,
          aiModel: options.upscale ? options.aiModel : undefined,
          normalizeAudio: options.normalizeAudio
        };
        generation.short = short;
        generation.shortError = undefined;
        generation.status = "done";
        generation.updatedAt = Date.now();
        await finishProjectJob(project, {
          progress: 100,
          message: `Short YouTube termine (1080 x 1920${options.upscale ? `, ${options.aiModel}` : ""}).`
        });
      } catch (error) {
        generation.status = abortMessage(error) ? "stopped" : "short-error";
        generation.shortError = error instanceof Error ? error.message : String(error);
        generation.updatedAt = Date.now();
        await finishProjectJob(project, {
          status: abortMessage(error) ? "interrupted" : "error",
          message: abortMessage(error) ? "Creation du Short arretee." : "Erreur pendant la creation du Short.",
          error: generation.shortError
        });
      }
    });

    res.status(202).json({ project, generation, job });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error("Operation arretee par l'utilisateur");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      const error = new Error("Operation arretee par l'utilisateur");
      error.name = "AbortError";
      reject(error);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseBatchVideoSettings(value: any): BatchVideoSettings {
  const quality = videoQualitySettings(value?.quality);
  const engine = "wan-s2v" as const;
  const continuity = "continuous" as const;
  const stabilizationSeconds = WAN_S2V_STABILIZATION_SECONDS;
  const short = parseShortOptions(value?.short);
  return {
    engine,
    upscale: false,
    quality: quality.profile,
    continuity,
    stabilizationSeconds,
    sourceMode: value?.sourceMode === "creative" ? "creative" : "strict",
    framing: value?.framing === "fit" || value?.framing === "crop" ? value.framing : "original",
    motionPrompt: s(value?.motionPrompt),
    width: Math.floor(n(value?.width, quality.width)),
    height: Math.floor(n(value?.height, quality.height)),
    steps: Math.max(4, Math.min(60, Math.floor(n(value?.steps, quality.steps)))),
    cfg: n(value?.cfg, quality.cfg),
    seed: Math.floor(n(value?.seed, 123456)),
    short: {
      enabled: boolValue(value?.short?.enabled, false),
      ...short
    }
  };
}

async function callLocalApi(route: string, body: unknown, signal: AbortSignal): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function waitForBatchProjectJob(
  batch: BatchRun,
  item: BatchRun["items"][number],
  project: AvatarProject,
  jobId: string,
  stageStart: number,
  stageSpan: number,
  signal: AbortSignal
): Promise<void> {
  while (true) {
    if (signal.aborted) throw Object.assign(new Error("Batch arrete"), { name: "AbortError" });
    const job = project.currentJob;
    if (!job || job.id !== jobId) throw new Error("Le job de generation a disparu.");
    item.progress = Math.min(99, stageStart + (Number(job.progress) || 0) * stageSpan / 100);
    item.message = job.message;
    const completed = batch.items.filter(candidate => candidate.status === "done" || candidate.status === "error").length;
    batch.progress = Math.min(99, Math.round((completed + item.progress / 100) / batch.items.length * 100));
    batch.message = `${item.avatarName} — ${item.message}`;
    await batchStore.save(batch);
    if (job.status === "done") return;
    if (job.status === "error" || job.status === "interrupted") {
      throw new Error(job.error || job.message || "Generation interrompue.");
    }
    await abortableDelay(750, signal);
  }
}

async function runBatch(batch: BatchRun, controller: AbortController): Promise<void> {
  batch.status = "running";
  batch.startedAt = batch.startedAt || Date.now();
  batch.finishedAt = undefined;
  batch.message = "Demarrage du batch…";
  await batchStore.save(batch);

  for (let index = 0; index < batch.items.length; index++) {
    const item = batch.items[index];
    if (item.status === "done") continue;
    batch.currentIndex = index;
    let project: AvatarProject | undefined;
    try {
      if (controller.signal.aborted) throw Object.assign(new Error("Batch arrete"), { name: "AbortError" });
      project = projectOrThrow(item.avatarId);
      if (!project.avatar) throw new Error("Avatar sans image.");
      if (!project.voiceFingerprint) throw new Error("Avatar sans empreinte vocale.");

      let generation = item.generationId
        ? (project.generations || []).find(candidate => candidate.id === item.generationId)
        : undefined;
      const wantsShort = batch.videoSettings.short?.enabled === true;
      const voiceEnd = wantsShort ? 25 : 35;
      const videoEnd = wantsShort ? 80 : 100;

      if (!generation?.voice) {
        item.status = "voice";
        item.progress = 1;
        item.error = undefined;
        item.message = "Generation de la voix…";
        await batchStore.save(batch);
        const payload = await callLocalApi("/api/voice/generate", {
          projectId: project.id,
          generationId: generation?.id,
          generationName: generation ? undefined : item.name,
          text: item.text,
          language: "French",
          speed: 1,
          voiceSeed: 123456,
          batchId: batch.id
        }, controller.signal);
        item.generationId = String(payload.generation.id);
        generation = payload.generation as AvatarGeneration;
        await batchStore.save(batch);
        await waitForBatchProjectJob(batch, item, project, payload.job.id, 0, voiceEnd, controller.signal);
        generation = generationOrThrow(project, item.generationId);
      }

      if (!generation?.video) {
        item.status = "video";
        item.progress = Math.max(item.progress, voiceEnd);
        item.message = "Generation de la video…";
        await batchStore.save(batch);
        const payload = await callLocalApi("/api/video/generate", {
          projectId: project.id,
          generationId: generation!.id,
          batchId: batch.id,
          ...batch.videoSettings
        }, controller.signal);
        await waitForBatchProjectJob(batch, item, project, payload.job.id, voiceEnd, videoEnd - voiceEnd, controller.signal);
        generation = generationOrThrow(project, item.generationId!);
      }

      if (wantsShort && !generation?.short) {
        item.status = "short";
        item.progress = Math.max(item.progress, videoEnd);
        item.message = batch.videoSettings.short?.upscale
          ? "Creation du Short et upscale Real-ESRGAN…"
          : "Creation du Short YouTube…";
        await batchStore.save(batch);
        const payload = await callLocalApi("/api/short/generate", {
          projectId: project.id,
          generationId: generation!.id,
          batchId: batch.id,
          ...batch.videoSettings.short
        }, controller.signal);
        await waitForBatchProjectJob(batch, item, project, payload.job.id, videoEnd, 100 - videoEnd, controller.signal);
      }

      item.status = "done";
      item.progress = 100;
      item.message = wantsShort ? "Voix, video et Short termines" : "Voix et video terminees";
      item.error = undefined;
    } catch (error) {
      if (controller.signal.aborted || abortMessage(error)) {
        item.status = "stopped";
        item.message = "Arrete — ce point sera repris";
        batch.status = "stopped";
        batch.finishedAt = Date.now();
        batch.message = `Batch arrete sur ${item.avatarName}.`;
        await batchStore.save(batch);
        batchControllers.delete(batch.id);
        return;
      }
      const failedStage = item.status;
      item.status = "error";
      item.error = error instanceof Error ? error.message : String(error);
      item.message = "Erreur — reprise possible";
      if (item.generationId && project) {
        const generation = (project.generations || []).find(candidate => candidate.id === item.generationId);
        if (generation) {
          if (failedStage === "short") {
            generation.status = "short-error";
            generation.shortError = item.error;
          } else {
            generation.status = "error";
            generation.error = item.error;
          }
          generation.updatedAt = Date.now();
          await store.save(project);
        }
      }
    }
    const completed = batch.items.filter(candidate => candidate.status === "done" || candidate.status === "error").length;
    batch.progress = Math.round(completed / batch.items.length * 100);
    await batchStore.save(batch);
  }

  const failed = batch.items.filter(item => item.status === "error").length;
  batch.status = failed ? "error" : "done";
  batch.progress = 100;
  batch.finishedAt = Date.now();
  batch.message = failed
    ? `Batch termine avec ${failed} erreur(s). Relance-le pour retraiter les lignes en erreur.`
    : `Batch termine : ${batch.items.length} generation(s).`;
  await batchStore.save(batch);
  batchControllers.delete(batch.id);
}

function assertNoOtherBatch(activeId?: string): void {
  const active = batchStore.list().find(batch => batch.id !== activeId && (batch.status === "running" || batch.status === "queued" || batch.status === "stopping"));
  if (active) throw new Error(`Le batch « ${active.name} » utilise deja la machine.`);
}

app.get("/api/batches", (_req, res) => res.json({ batches: batchStore.list() }));

app.get("/api/batches/:id", (req, res) => {
  const batch = batchStore.get(req.params.id);
  if (!batch) return res.status(404).json({ error: "Batch inconnu." });
  res.json({ batch });
});

app.post("/api/batches", async (req, res) => {
  try {
    assertNoOtherBatch();
    const name = s(req.body?.name);
    if (!name) throw new Error("Le nom du batch est obligatoire.");
    const rows = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rows.length) throw new Error("Ajoute au moins une ligne au batch.");
    if (rows.length > 100) throw new Error("Un batch est limite a 100 generations.");
    const items = rows.map((row: any, index: number) => {
      const project = projectOrThrow(row.avatarId);
      if (!project.avatar) throw new Error(`Ligne ${index + 1} : l'avatar n'a pas d'image.`);
      if (!project.voiceFingerprint) throw new Error(`Ligne ${index + 1} : l'avatar n'a pas d'empreinte vocale.`);
      const itemName = s(row.name);
      const text = s(row.text);
      if (!itemName) throw new Error(`Ligne ${index + 1} : nom de generation manquant.`);
      if (!text) throw new Error(`Ligne ${index + 1} : texte manquant.`);
      return batchStore.newItem({ avatarId: project.id, avatarName: project.name, name: itemName.slice(0, 120), text });
    });
    const batch = await batchStore.create({
      name: name.slice(0, 120),
      status: "queued",
      currentIndex: 0,
      progress: 0,
      message: "En attente",
      items,
      videoSettings: parseBatchVideoSettings(req.body?.videoSettings)
    });
    const controller = new AbortController();
    batchControllers.set(batch.id, controller);
    runDetached(() => runBatch(batch, controller));
    res.status(202).json({ batch });
  } catch (error) {
    res.status(error instanceof RangeError ? 400 : 400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/batches/:id/stop", async (req, res) => {
  try {
    const batch = batchStore.get(req.params.id);
    if (!batch) return res.status(404).json({ error: "Batch inconnu." });
    if (batch.status !== "running" && batch.status !== "queued") return res.json({ batch });
    batch.status = "stopping";
    batch.message = "Arret demande…";
    await batchStore.save(batch);
    batchControllers.get(batch.id)?.abort();
    const current = batch.items[batch.currentIndex];
    const project = current ? store.get(current.avatarId) : undefined;
    const job = project?.currentJob;
    if (job && job.batchId === batch.id && (job.status === "queued" || job.status === "running")) {
      activeControllers.get(job.id)?.abort();
      if (job.type === "video-wan") await comfy.cancelPrompt();
      if (job.type === "voice") await tts.hardStop();
    }
    res.json({ batch });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

async function resumeBatch(batch: BatchRun, restart: boolean): Promise<void> {
  assertNoOtherBatch(batch.id);
  if (batch.status === "running" || batch.status === "queued" || batch.status === "stopping") {
    throw new Error("Ce batch est deja en cours.");
  }
  for (const item of batch.items) {
    if (restart || item.status === "error" || item.status === "stopped") {
      item.status = "pending";
      item.progress = 0;
      item.message = "En attente";
      item.error = undefined;
      if (restart) item.generationId = undefined;
    }
  }
  batch.status = "queued";
  batch.currentIndex = 0;
  batch.progress = restart ? 0 : Math.round(batch.items.filter(item => item.status === "done").length / batch.items.length * 100);
  batch.message = restart ? "Redemarrage complet…" : "Reprise des elements non termines…";
  batch.startedAt = restart ? undefined : batch.startedAt;
  batch.finishedAt = undefined;
  await batchStore.save(batch);
  const controller = new AbortController();
  batchControllers.set(batch.id, controller);
  runDetached(() => runBatch(batch, controller));
}

app.post("/api/batches/:id/resume", async (req, res) => {
  try {
    const batch = batchStore.get(req.params.id);
    if (!batch) return res.status(404).json({ error: "Batch inconnu." });
    await resumeBatch(batch, false);
    res.status(202).json({ batch });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/batches/:id/restart", async (req, res) => {
  try {
    const batch = batchStore.get(req.params.id);
    if (!batch) return res.status(404).json({ error: "Batch inconnu." });
    await resumeBatch(batch, true);
    res.status(202).json({ batch });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/project/:id/stop", async (req, res) => {
  try {
    const project = projectOrThrow(req.params.id);
    const job = activeJob(project);
    if (!job) return res.json({ project });
    activeControllers.get(job.id)?.abort();
    if (job.type === "video-wan" || job.type === "image") await comfy.cancelPrompt();
    if (job.type === "voice" || job.type === "voice-fingerprint") await tts.hardStop();
    res.json({ project });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`DGX Avatar Studio : http://127.0.0.1:${port}`);
  console.log(`Données persistantes : ${dataRoot}`);
  console.log(`Projets : ${projectRoot}`);
});
