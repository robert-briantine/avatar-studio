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
import { assembleWanVideo, checkWanTransitions, createSegmentVideo, mediaHealth, probeDuration } from "./media.js";
import { voicePresets, getVoicePreset } from "./voicePresets.js";
import { AvatarStore, type AvatarProject, type ProjectJob } from "./avatarStore.js";
import { buildWanS2VExtendedWorkflow, buildWanS2VStabilizedWorkflow, planWanS2VWindows, parseWanStabilizationSeconds, WAN_S2V_MODELS, WAN_S2V_NODES, WAN_S2V_STABLE_NODES, WAN_S2V_CHUNK_FRAMES, WAN_S2V_FPS } from "./wanS2V.js";
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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const comfy = new ComfyClient();
const tts = new TtsClient();
const generator = new GeneratorService(transientRoot, comfy, tts);
const store = new AvatarStore(projectRoot);
await store.init();

app.use(express.json({ limit: "4mb" }));
app.use(express.static(publicDir));
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

async function createProjectJob(project: AvatarProject, type: ProjectJob["type"], message: string): Promise<ProjectJob> {
  const existing = activeJob(project);
  if (existing) throw new Error(`Une génération est déjà en cours : ${existing.message}`);
  const job: ProjectJob = {
    id: randomUUID(),
    type,
    status: "queued",
    createdAt: Date.now(),
    progress: 0,
    message
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
  await store.save(project);
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

    runDetached(async () => {
      try {
        await updateProjectJob(project, { status: "running", startedAt: Date.now(), progress: 5, message: "Génération de l'image avec Qwen-Image…" });
        if (strictReset) await comfy.resetImageSession();
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
          });
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
        await finishProjectJob(project, { status: "error", progress: project.currentJob?.progress || 0, message: "Erreur pendant la génération de l'image.", error: error instanceof Error ? error.message : String(error) });
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

app.post("/api/voice/generate", async (req, res) => {
  try {
    const project = projectOrThrow(req.body.projectId);
    const text = String(req.body.text || "").trim();
    if (!text) throw new Error("Le texte à lire est vide.");
    const presetId = String(req.body.voicePreset || "narrator");
    const preset = getVoicePreset(presetId);
    const voicePrompt = String(req.body.voicePrompt || "").trim() || preset.prompt;
    const voiceSeedRaw = n(req.body.voiceSeed, 123456);
    const job = await createProjectJob(project, "voice", "Génération de la voix en attente…");

    runDetached(async () => {
      try {
        await updateProjectJob(project, { status: "running", startedAt: Date.now(), progress: 5, message: "Génération Qwen3-TTS…" });
        const audio = await generator.generateVoice({
          voiceText: text,
          voicePrompt,
          voicePresetId: presetId,
          voiceLanguage: String(req.body.language || "French"),
          voiceSpeed: n(req.body.speed, 1),
          voiceSeed: Math.floor(voiceSeedRaw)
        }, {
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
        const filename = "speech.wav";
        const target = path.join(base, "voice", filename);
        await copyAsset(audio.path, target);
        project.voice = {
          name: filename,
          path: target,
          url: pub(project.id, "voice", filename),
          duration: audio.duration,
          text,
          presetId,
          voicePrompt,
          seed: Math.floor(voiceSeedRaw)
        };
        project.video = undefined;
        await finishProjectJob(project, { message: `Voix terminée (${audio.duration.toFixed(1)} s).`, progress: 100 });
      } catch (error) {
        await finishProjectJob(project, { status: "error", progress: project.currentJob?.progress || 0, message: "Erreur pendant la génération de la voix.", error: error instanceof Error ? error.message : String(error) });
      }
    });

    res.status(202).json({ project, job });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
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
    if (!project.avatar) throw new Error("Génère ou charge d'abord un avatar.");
    if (!project.voice) throw new Error("Génère d'abord la voix.");
    const job = await createProjectJob(project, "video-preview", "Création de la vidéo test en attente…");
    runDetached(async () => {
      try {
        await updateProjectJob(project, { status: "running", startedAt: Date.now(), progress: 10, message: "Création de la vidéo test avec FFmpeg…" });
        const base = await store.ensure(project);
        const filename = "avatar-preview.mp4";
        const target = path.join(base, "video", filename);
        const duration = await createSegmentVideo(project.avatar!.path, project.voice!.path, target);
        project.video = { name: filename, path: target, url: pub(project.id, "video", filename), duration, engine: "preview" };
        await finishProjectJob(project, { message: "Vidéo test terminée.", progress: 100 });
      } catch (error) {
        await finishProjectJob(project, { status: "error", message: "Erreur pendant la vidéo test.", error: error instanceof Error ? error.message : String(error) });
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
    if (!project.avatar) throw new Error("Génère ou charge d'abord un avatar.");
    if (!project.voice) throw new Error("Génère d'abord la voix.");

    const stabilized = req.body.continuity !== "continuous";
    // Valider avant de créer un job ou de contacter ComfyUI. Le mode continu
    // ignore ce champ, mais conserve le dernier délai choisi pour le projet.
    const stabilizationSeconds = parseWanStabilizationSeconds(stabilized
      ? (req.body.stabilizationSeconds === undefined ? project.videoSettings?.stabilizationSeconds : req.body.stabilizationSeconds)
      : project.videoSettings?.stabilizationSeconds);
    const job = await createProjectJob(project, "video-wan", "Génération Wan2.2-S2V native Extend en attente…");
    project.videoSettings = { continuity: stabilized ? "stable" : "continuous", stabilizationSeconds };
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
        const total = project.voice!.duration || await probeDuration(project.voice!.path);
        const requestedWidth = Math.floor(n(req.body.width, videoQuality.width));
        const requestedHeight = Math.floor(n(req.body.height, videoQuality.height));
        const steps = Math.max(4, Math.min(60, Math.floor(n(req.body.steps, videoQuality.steps))));
        const cfg = n(req.body.cfg, videoQuality.cfg);
        const seed = Math.floor(n(req.body.seed, 123456));

        const sourceMode: VideoSourceMode = req.body.sourceMode === "creative" ? "creative" : "strict";
        const framing: VideoFramingMode =
          req.body.framing === "fit" || req.body.framing === "crop" ? req.body.framing : "original";

        const totalFrames = Math.max(1, Math.ceil(total * WAN_S2V_FPS));
        const plannedWindows = stabilized ? planWanS2VWindows(total, stabilizationSeconds) : undefined;
        const chunks = plannedWindows
          ? plannedWindows.reduce((sum, window) => sum + Math.ceil(window.frames / WAN_S2V_CHUNK_FRAMES), 0)
          : Math.max(1, Math.ceil(totalFrames / WAN_S2V_CHUNK_FRAMES));
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
          message: `Wan2.2 natif : ${chunks} passe(s) de ${WAN_S2V_CHUNK_FRAMES} frames pour ${total.toFixed(1)} s d'audio…`
        });

        const base = await store.ensure(project);
        const workDir = path.join(transientRoot, `wan-extend-${project.id}-${randomUUID()}`);
        await fs.mkdir(workDir, { recursive: true });
        tempFiles.push(workDir);

        // Image de référence : aucun traitement en mode Original.
        const sourceExt = path.extname(project.avatar!.path) || ".png";
        const imageExt = framing === "original" ? sourceExt : ".png";
        const imageName = `wan-avatar-${project.id}-${randomUUID()}${imageExt}`;
        await prepareWanReferenceImage(
          project.avatar!.path,
          path.join(comfyInputDir, imageName),
          requestedWidth,
          requestedHeight,
          framing
        );

        // Un seul fichier WAV : le mode stabilisé en extrait les fenêtres dans
        // ComfyUI. Le WAV complet reste la piste audio finale dans les deux modes.
        const audioName = `wan-audio-full-${project.id}-${randomUUID()}.wav`;
        await fs.copyFile(project.voice!.path, path.join(comfyInputDir, audioName));

        const userMotionPrompt = String(req.body.motionPrompt || "").trim();
        const prompt = sourceMode === "strict"
          ? ""
          : (userMotionPrompt || "The subject speaks naturally with synchronized mouth movement while keeping the camera stable and preserving the original appearance and background.");

        const buildVideoWorkflow = stabilized ? buildWanS2VStabilizedWorkflow : buildWanS2VExtendedWorkflow;
        const { graph, generatedFrames, windows } = buildVideoWorkflow({
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
        });

        // Évite de vider les poids et le cache à chaque nouvelle vidéo.
        // ComfyUI libère lui-même de la mémoire lorsque le workflow en a besoin.
        if (config.video.freeMemoryBeforeWan) await comfy.freeMemory().catch(() => undefined);
        await updateProjectJob(project, {
          progress: 10,
          current: 1,
          total: chunks,
          message: windows
            ? `Calcul Wan2.2 : ${chunks} passe(s), pose reconstruite depuis l'avatar original toutes les ${stabilizationSeconds} s…`
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
                  ? `Wan2.2 : bloc ${current}/${chunks}, reprise depuis la dernière image…`
                  : `Wan2.2 : bloc ${current}/${chunks} depuis l'image originale…`)
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
        });

        let ref;
        try {
          ref = await comfy.waitForFile(tracked.promptId, [".mp4", ".mkv", ".webm"], 0);
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

        const bytes = await comfy.downloadFile(ref);
        const raw = path.join(workDir, "wan-extended-raw.mp4");
        await fs.writeFile(raw, bytes);

        const filename = "avatar-speaking-wan2.2-extend.mp4";
        const target = path.join(base, "video", filename);
        // Fusionne les mêmes instants des fenêtres voisines, puis remet le WAV
        // original. Le mode continu garde sa simple coupe de fin habituelle.
        await assembleWanVideo(raw, project.voice!.path, target, total, windows);

        const duration = await probeDuration(target).catch(() => total);
        project.video = {
          name: filename,
          path: target,
          url: pub(project.id, "video", filename),
          duration,
          engine: "wan-s2v",
          continuity: stabilized ? "stable" : "continuous",
          stabilizationSeconds: stabilized ? stabilizationSeconds : undefined
        };

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
        await finishProjectJob(project, {
          status: "error",
          message: "Erreur pendant la génération Wan2.2 Extend.",
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        for (const p of tempFiles) await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    res.status(202).json({ project, job });
  } catch (e) {
    res.status(e instanceof RangeError ? 400 : 500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

const port = Number(process.env.PORT || 3010);
app.listen(port, "0.0.0.0", () => {
  console.log(`DGX Avatar Studio : http://127.0.0.1:${port}`);
  console.log(`Données persistantes : ${dataRoot}`);
  console.log(`Projets : ${projectRoot}`);
});
