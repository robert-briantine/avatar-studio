import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ComfyClient } from "./comfy.js";
import { buildWanS2VExtendedWorkflow, WAN_S2V_CHUNK_FRAMES, WAN_S2V_FPS, WAN_S2V_MODELS, WAN_S2V_NODES } from "./wanS2V.js";
import { probeDuration, trimVideoDuration } from "./media.js";

export type BenchmarkMode = "sequential" | "parallel";

export type BenchmarkJobResult = {
  index: number;
  worker: string;
  seed: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  comfyDurationMs?: number;
  postProcessDurationMs?: number;
  comfyFinishedAt?: number;
  ok: boolean;
  error?: string;
  output?: string;
};

export type BenchmarkRun = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  mode: BenchmarkMode;
  requestedConcurrency: number;
  effectiveConcurrency: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  progress: number;
  globalDurationMs?: number;
  globalComputeDurationMs?: number;
  jobsPerMinute?: number;
  computeJobsPerMinute?: number;
  speedupVsSequentialEstimate?: number;
  imageName: string;
  wavName: string;
  audioDurationSeconds?: number;
  settings: {
    width: number;
    height: number;
    steps: number;
    cfg: number;
    seed: number;
    strictIdentity: boolean;
  };
  workers: string[];
  results: BenchmarkJobResult[];
  message: string;
  error?: string;
  logFile?: string;
};

export function parseBenchmarkWorkers(): string[] {
  const raw = (process.env.COMFY_BENCH_WORKERS || "http://127.0.0.1:8188,http://127.0.0.1:8189,http://127.0.0.1:8190,http://127.0.0.1:8191").trim();
  return raw.split(",").map(x => x.trim().replace(/\/$/, "")).filter(Boolean).slice(0, 4);
}

async function validateWorker(url: string): Promise<void> {
  const comfy = new ComfyClient(url);
  const nodes = await comfy.hasNodes([...WAN_S2V_NODES]);
  if (!nodes.ok) throw new Error(`${url}: node(s) manquant(s): ${nodes.missing.join(", ")}`);
  const info = await comfy.nodeInfo();
  const hasModel = (node: string, model: string) => JSON.stringify(info?.[node] ?? {}).includes(`"${model}"`);
  const missing = [
    hasModel("UNETLoader", WAN_S2V_MODELS.diffusion) ? null : WAN_S2V_MODELS.diffusion,
    hasModel("CLIPLoader", WAN_S2V_MODELS.textEncoder) ? null : WAN_S2V_MODELS.textEncoder,
    hasModel("AudioEncoderLoader", WAN_S2V_MODELS.audioEncoder) ? null : WAN_S2V_MODELS.audioEncoder,
    hasModel("VAELoader", WAN_S2V_MODELS.vae) ? null : WAN_S2V_MODELS.vae
  ].filter(Boolean);
  if (missing.length) throw new Error(`${url}: modèle(s) manquant(s): ${missing.join(", ")}`);
}

export async function availableBenchmarkWorkers(urls = parseBenchmarkWorkers()): Promise<Array<{ url: string; ok: boolean; error?: string }>> {
  return await Promise.all(urls.map(async url => {
    try {
      await validateWorker(url);
      return { url, ok: true };
    } catch (error) {
      return { url, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

export async function executeBenchmark(args: {
  run: BenchmarkRun;
  imageInputName: string;
  wavInputName: string;
  logsDir: string;
  outputsDir: string;
  onUpdate: (run: BenchmarkRun) => Promise<void> | void;
}): Promise<void> {
  const { run, imageInputName, wavInputName, logsDir, outputsDir, onUpdate } = args;
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(outputsDir, { recursive: true });

  run.status = "running";
  run.startedAt = Date.now();
  run.message = "Validation des workers ComfyUI…";
  await onUpdate(run);

  const health = await availableBenchmarkWorkers(run.workers);
  const ready = health.filter(x => x.ok).map(x => x.url);
  const wanted = run.mode === "sequential" ? 1 : run.requestedConcurrency;
  if (ready.length < wanted) {
    const detail = health.filter(x => !x.ok).map(x => x.error).join(" | ");
    throw new Error(`Seulement ${ready.length}/${wanted} worker(s) ComfyUI prêt(s). ${detail}`);
  }

  run.effectiveConcurrency = Math.min(wanted, ready.length, run.totalJobs);
  run.workers = ready.slice(0, run.effectiveConcurrency);
  run.message = `Benchmark en cours avec ${run.effectiveConcurrency} worker(s)…`;
  await onUpdate(run);

  const duration = await probeDuration(path.join(process.env.COMFY_INPUT_DIR || "", wavInputName));
  run.audioDurationSeconds = duration;

  let nextIndex = 0;
  const launchWorkerLoop = async (workerUrl: string) => {
    const comfy = new ComfyClient(workerUrl);
    while (true) {
      const index = nextIndex++;
      if (index >= run.totalJobs) return;
      const seed = run.settings.seed + index;
      const startedAt = Date.now();
      const result: BenchmarkJobResult = {
        index: index + 1,
        worker: workerUrl,
        seed,
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        ok: false
      };
      try {
        const prefix = `dgx-benchmark/${run.id}/job-${String(index + 1).padStart(2, "0")}-${randomUUID().slice(0, 8)}`;
        const { graph } = buildWanS2VExtendedWorkflow({
          imageName: imageInputName,
          audioName: wavInputName,
          prompt: "",
          strictIdentity: run.settings.strictIdentity,
          seed,
          width: run.settings.width,
          height: run.settings.height,
          durationSeconds: duration,
          steps: run.settings.steps,
          cfg: run.settings.cfg,
          filenamePrefix: prefix,
          chunkFrames: WAN_S2V_CHUNK_FRAMES
        });

        const promptId = await comfy.queue(graph);
        const ref = await comfy.waitForFile(promptId, [".mp4", ".mkv", ".webm"], 0);
        result.comfyFinishedAt = Date.now();
        result.comfyDurationMs = result.comfyFinishedAt - startedAt;
        const raw = await comfy.downloadFile(ref);
        const rawPath = path.join(outputsDir, `${run.id}-job-${index + 1}-raw.mp4`);
        const finalPath = path.join(outputsDir, `${run.id}-job-${index + 1}.mp4`);
        await fs.writeFile(rawPath, raw);
        await trimVideoDuration(rawPath, finalPath, duration);
        await fs.rm(rawPath, { force: true });
        result.ok = true;
        result.output = finalPath;
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      } finally {
        result.finishedAt = Date.now();
        result.durationMs = result.finishedAt - startedAt;
        if (result.comfyFinishedAt) result.postProcessDurationMs = result.finishedAt - result.comfyFinishedAt;
        run.results.push(result);
        run.completedJobs = run.results.length;
        run.failedJobs = run.results.filter(x => !x.ok).length;
        run.progress = Math.round((run.completedJobs / run.totalJobs) * 1000) / 10;
        const elapsed = Date.now() - (run.startedAt || Date.now());
        run.message = `${run.completedJobs}/${run.totalJobs} terminé(s) — ${Math.round(elapsed / 1000)} s globales écoulées`;
        await onUpdate(run);
      }
    }
  };

  await Promise.all(run.workers.map(url => launchWorkerLoop(url)));
  run.finishedAt = Date.now();
  run.globalDurationMs = run.finishedAt - (run.startedAt || run.finishedAt);
  const latestComfyFinish = Math.max(...run.results.map(x => x.comfyFinishedAt || 0));
  run.globalComputeDurationMs = latestComfyFinish > 0 && run.startedAt ? latestComfyFinish - run.startedAt : undefined;
  const successes = run.results.filter(x => x.ok).length;
  run.jobsPerMinute = run.globalDurationMs > 0 ? successes * 60_000 / run.globalDurationMs : 0;
  run.computeJobsPerMinute = run.globalComputeDurationMs && run.globalComputeDurationMs > 0 ? successes * 60_000 / run.globalComputeDurationMs : undefined;
  run.status = run.failedJobs === run.totalJobs ? "error" : "done";
  run.progress = 100;
  run.message = `${successes}/${run.totalJobs} génération(s) réussie(s) en ${(run.globalDurationMs / 1000).toFixed(1)} s.`;

  const logFile = path.join(logsDir, `${new Date(run.createdAt).toISOString().replace(/[:.]/g, "-")}-${run.id}.json`);
  run.logFile = logFile;
  await fs.writeFile(logFile, JSON.stringify(run, null, 2), "utf8");
  await onUpdate(run);
}
