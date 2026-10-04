import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type VideoEngine = "wan-s2v" | "hybrid" | "longcat";
export type ExternalVideoEngine = Exclude<VideoEngine, "wan-s2v">;

export type ExternalVideoProgress = {
  progress: number;
  message: string;
};

export const VIDEO_ENGINE_LABELS: Record<VideoEngine, string> = {
  "wan-s2v": "Wan2.2-S2V (mode actuel)",
  hybrid: "LivePortrait + MuseTalk 1.5",
  longcat: "LongCat Avatar 1.5"
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(moduleDir, "..");
const defaultEnginesRoot = "/home/blockapicoder/dgx-avatar-engines";

export function parseVideoEngine(value: unknown): VideoEngine {
  return value === "hybrid" || value === "longcat" ? value : "wan-s2v";
}

export function videoEngineJobType(engine: VideoEngine): "video-wan" | "video-hybrid" | "video-longcat" {
  if (engine === "hybrid") return "video-hybrid";
  if (engine === "longcat") return "video-longcat";
  return "video-wan";
}

function engineRoot(): string {
  return process.env.DGX_VIDEO_ENGINES_ROOT?.trim() || defaultEnginesRoot;
}

async function regularFile(file: string, minimumBytes = 1): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size >= minimumBytes;
  } catch {
    return false;
  }
}

async function directory(dir: string): Promise<boolean> {
  try { return (await fs.stat(dir)).isDirectory(); } catch { return false; }
}

export type ExternalEngineHealth = {
  ok: boolean;
  code: boolean;
  models: boolean;
  image: string;
  missing: string[];
};

async function dockerImageExists(image: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn("docker", ["image", "inspect", image], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", code => resolve(code === 0));
  });
}

export async function externalVideoEngineHealth(): Promise<Record<ExternalVideoEngine, ExternalEngineHealth>> {
  const root = engineRoot();
  const hybridImage = process.env.DGX_HYBRID_IMAGE?.trim() || "dgx-avatar-hybrid:local";
  const longcatImage = process.env.DGX_LONGCAT_IMAGE?.trim() || "dgx-avatar-longcat:local";
  const hybridChecks = [
    ["LivePortrait", directory(path.join(root, "src", "LivePortrait"))],
    ["MuseTalk", directory(path.join(root, "src", "MuseTalk"))],
    ["LivePortrait weights", regularFile(path.join(root, "src", "LivePortrait", "pretrained_weights", "liveportrait", "base_models", "appearance_feature_extractor.pth"), 1_000_000)],
    ["MuseTalk 1.5 weights", regularFile(path.join(root, "src", "MuseTalk", "models", "musetalkV15", "unet.pth"), 1_000_000)]
  ] as const;
  const longcatChecks = [
    ["LongCat-Video", directory(path.join(root, "src", "LongCat-Video"))],
    ["LongCat base weights", directory(path.join(root, "src", "LongCat-Video", "weights", "LongCat-Video", "vae"))],
    ["LongCat Avatar 1.5 INT8", directory(path.join(root, "src", "LongCat-Video", "weights", "LongCat-Video-Avatar-1.5", "base_model_int8"))]
  ] as const;
  const [hybridImageOk, longcatImageOk, hybridResolved, longcatResolved] = await Promise.all([
    dockerImageExists(hybridImage), dockerImageExists(longcatImage),
    Promise.all(hybridChecks.map(async ([name, check]) => [name, await check] as const)),
    Promise.all(longcatChecks.map(async ([name, check]) => [name, await check] as const))
  ]);
  const result = (
    image: string, imageOk: boolean, checks: ReadonlyArray<readonly [string, boolean]>
  ): ExternalEngineHealth => {
    const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
    if (!imageOk) missing.push(`image Docker ${image}`);
    const code = checks.slice(0, 2).every(([, ok]) => ok);
    const models = checks.slice(2).every(([, ok]) => ok);
    return { ok: imageOk && code && models, code, models, image, missing };
  };
  return {
    hybrid: result(hybridImage, hybridImageOk, hybridResolved),
    longcat: result(longcatImage, longcatImageOk, longcatResolved)
  };
}

function abortError(): Error {
  const error = new Error("Génération vidéo arrêtée par l'utilisateur");
  error.name = "AbortError";
  return error;
}

export async function generateExternalVideo(args: {
  engine: ExternalVideoEngine;
  imagePath: string;
  audioPath: string;
  outputPath: string;
  workDir: string;
  prompt?: string;
  upscale?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: ExternalVideoProgress) => void;
}): Promise<void> {
  if (args.signal?.aborted) throw abortError();
  const runner = process.env.DGX_VIDEO_ENGINE_RUNNER?.trim() || path.join(appRoot, "scripts", "run-video-engine.py");
  const python = process.env.DGX_VIDEO_ENGINE_PYTHON?.trim() || "python3";
  const commandArgs = [
    runner,
    "--engine", args.engine,
    "--image", path.resolve(args.imagePath),
    "--audio", path.resolve(args.audioPath),
    "--output", path.resolve(args.outputPath),
    "--work-dir", path.resolve(args.workDir),
    "--engines-root", engineRoot(),
    "--app-root", appRoot,
    "--upscale", args.upscale === false ? "false" : "true"
  ];
  if (args.prompt?.trim()) commandArgs.push("--prompt", args.prompt.trim());

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.mkdir(args.workDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(python, commandArgs, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let stopped = false;
    let settled = false;
    const feed = (chunk: Buffer) => {
      const text = chunk.toString();
      log = `${log}${text}`.slice(-512 * 1024);
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^DGX_PROGRESS\s+(\d+(?:\.\d+)?)\s+(.+)$/);
        if (match) args.onProgress?.({ progress: Number(match[1]), message: match[2] });
      }
    };
    const cleanup = () => args.signal?.removeEventListener("abort", onAbort);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const onAbort = () => {
      stopped = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 10_000).unref();
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.once("error", error => finish(error));
    child.once("close", code => {
      if (stopped || args.signal?.aborted) return finish(abortError());
      if (code === 0) return finish();
      finish(new Error(`${VIDEO_ENGINE_LABELS[args.engine]} s'est arrêté avec le code ${code}.\n${log.slice(-8000)}`));
    });
    args.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
