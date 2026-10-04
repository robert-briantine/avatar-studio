import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ShortFraming = "blur" | "crop" | "fit";
export type ShortAiModel = "RealESRGAN_x2plus" | "RealESRGAN_x4plus";

export type ShortOptions = {
  framing: ShortFraming;
  upscale: boolean;
  aiModel: ShortAiModel;
  normalizeAudio: boolean;
};

export type ShortProgress = { progress: number; message: string };

type VideoInfo = {
  width: number;
  height: number;
  duration: number;
  fps: string;
  hasAudio: boolean;
};

const MAX_DURATION_SECONDS = 180.25;
const MAX_LOG_BYTES = 512 * 1024;
const defaultShortMakerRoot = "/home/blockapicoder/dgx-short-maker-fixed/dgx-short-maker";

function abortError(): Error {
  const error = new Error("Creation du Short arretee par l'utilisateur");
  error.name = "AbortError";
  return error;
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; onData?: (text: string) => void } = {}
): Promise<string> {
  if (options.signal?.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, detached: grouped });
    let log = "";
    let settled = false;
    const feed = (buffer: Buffer) => {
      const text = buffer.toString();
      log = `${log}${text}`.slice(-MAX_LOG_BYTES);
      options.onData?.(text);
    };
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve(log);
    };
    const onAbort = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", finish);
    child.on("close", code => {
      if (options.signal?.aborted) return finish(abortError());
      if (code === 0) return finish();
      finish(new Error(`${command} s'est arrete avec le code ${code}\n${log}`));
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function shortVideoFilter(mode: ShortFraming, width = 1080, height = 1920, enhance = false): {
  type: "simple" | "complex";
  filter: string;
  map?: string;
} {
  const flags = "lanczos+accurate_rnd+full_chroma_int";
  const finish = `${enhance ? ",unsharp=5:5:0.28:3:3:0" : ""},format=yuv420p`;
  if (mode === "fit") {
    return {
      type: "simple",
      filter: `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=${flags},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1${finish}`
    };
  }
  if (mode === "blur") {
    return {
      type: "complex",
      filter: `[0:v:0]split=2[base][front];[base]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=${flags},crop=${width}:${height},eq=brightness=-0.07:saturation=0.78,boxblur=30:15,setsar=1[bg];[front]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=${flags},setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1${finish}[vout]`,
      map: "[vout]"
    };
  }
  return {
    type: "simple",
    filter: `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=${flags},crop=${width}:${height},setsar=1${finish}`
  };
}

export function parseShortOptions(value: any): ShortOptions {
  return {
    framing: value?.framing === "crop" || value?.framing === "fit" ? value.framing : "blur",
    upscale: value?.upscale === true || value?.upscale === "true" || value?.upscale === 1,
    aiModel: value?.aiModel === "RealESRGAN_x4plus" ? "RealESRGAN_x4plus" : "RealESRGAN_x2plus",
    normalizeAudio: value?.normalizeAudio === undefined
      ? true
      : value.normalizeAudio === true || value.normalizeAudio === "true" || value.normalizeAudio === 1
  };
}

function addFilter(args: string[], filter: ReturnType<typeof shortVideoFilter>): void {
  if (filter.type === "complex") args.push("-filter_complex", filter.filter, "-map", filter.map!);
  else args.push("-vf", filter.filter, "-map", "0:v:0");
}

function addAudio(args: string[], info: VideoInfo, normalize: boolean): void {
  if (!info.hasAudio) return;
  args.push("-map", "0:a:0?");
  if (normalize) args.push("-af", "loudnorm=I=-14:TP=-1.5:LRA=11");
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
}

async function probe(file: string, signal?: AbortSignal): Promise<VideoInfo> {
  const text = await run("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file
  ], { signal });
  const meta = JSON.parse(text);
  const video = meta.streams?.find((stream: any) => stream.codec_type === "video");
  if (!video) throw new Error("La generation ne contient aucune piste video exploitable.");
  return {
    width: Number(video.width),
    height: Number(video.height),
    duration: Number(meta.format?.duration || video.duration || 0),
    fps: String(video.avg_frame_rate || video.r_frame_rate || "16/1"),
    hasAudio: meta.streams.some((stream: any) => stream.codec_type === "audio")
  };
}

function ffmpegProgress(text: string, duration: number, start: number, end: number, emit: (event: ShortProgress) => void, message: string): void {
  const matches = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const match = matches.at(-1);
  if (!match || !duration) return;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  emit({ progress: Math.min(end, start + seconds / duration * (end - start)), message });
}

async function renderStandard(
  input: string, output: string, options: ShortOptions, info: VideoInfo,
  signal: AbortSignal | undefined, emit: (event: ShortProgress) => void
): Promise<void> {
  const args = ["-y", "-hide_banner", "-i", input];
  addFilter(args, shortVideoFilter(options.framing, 1080, 1920, true));
  addAudio(args, info, options.normalizeAudio);
  args.push(
    "-map_metadata", "-1", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
    "-profile:v", "high", "-level:v", "4.2", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-metadata:s:v:0", "rotate=0", output
  );
  emit({ progress: 5, message: "Conversion verticale 1080 x 1920…" });
  await run("ffmpeg", args, {
    signal,
    onData: text => ffmpegProgress(text, info.duration, 5, 98, emit, "Conversion verticale 1080 x 1920…")
  });
}

function aiPaths(model: ShortAiModel): { root: string; python: string; script: string; weight: string } {
  const root = process.env.DGX_SHORT_MAKER_ROOT?.trim() || defaultShortMakerRoot;
  const python = process.env.REALESRGAN_PYTHON?.trim() || path.join(root, ".venv-ai", "bin", "python");
  const script = process.env.REALESRGAN_VIDEO_SCRIPT?.trim() || path.join(root, "scripts", "realesrgan_video.py");
  const weight = path.join(root, "vendor", "Real-ESRGAN", "weights", `${model}.pth`);
  return { root, python, script, weight };
}

export async function shortMakerHealth(): Promise<{ ffmpeg: boolean; upscale: boolean; reason?: string }> {
  let ffmpeg = true;
  try { await run("ffmpeg", ["-version"]); } catch { ffmpeg = false; }
  const paths = aiPaths("RealESRGAN_x2plus");
  const x4 = aiPaths("RealESRGAN_x4plus");
  try {
    const [python, script, weightX2, weightX4] = await Promise.all([
      fs.stat(paths.python), fs.stat(paths.script), fs.stat(paths.weight), fs.stat(x4.weight)
    ]);
    if (!python.isFile() || !script.isFile() || !weightX2.isFile() || !weightX4.isFile()
      || weightX2.size < 1_000_000 || weightX4.size < 1_000_000) throw new Error("fichiers incomplets");
    return { ffmpeg, upscale: ffmpeg, reason: ffmpeg ? undefined : "FFmpeg est indisponible" };
  } catch {
    return { ffmpeg, upscale: false, reason: `Real-ESRGAN absent dans ${paths.root}` };
  }
}

async function renderAi(
  input: string, output: string, options: ShortOptions, info: VideoInfo,
  signal: AbortSignal | undefined, emit: (event: ShortProgress) => void
): Promise<void> {
  const scale = options.aiModel === "RealESRGAN_x4plus" ? 4 : 2;
  const intermediate = path.join(path.dirname(output), `.short-ai-${randomUUID()}.mkv`);
  try {
    const args = ["-y", "-hide_banner", "-i", input];
    if (options.framing === "crop") addFilter(args, shortVideoFilter("crop", 1080 / scale, 1920 / scale, false));
    else addFilter(args, {
      type: "simple",
      filter: `scale=${1080 / scale}:${1920 / scale}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos+accurate_rnd+full_chroma_int,setsar=1,format=yuv420p`
    });
    addAudio(args, info, options.normalizeAudio);
    args.push("-map_metadata", "-1", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", intermediate);
    emit({ progress: 5, message: "Preparation sans perte pour Real-ESRGAN…" });
    await run("ffmpeg", args, {
      signal,
      onData: text => ffmpegProgress(text, info.duration, 5, 25, emit, "Preparation sans perte pour Real-ESRGAN…")
    });

    const paths = aiPaths(options.aiModel);
    await fs.access(paths.weight).catch(() => { throw new Error(`Poids IA absents : ${paths.weight}`); });
    emit({ progress: 27, message: `Upscale Real-ESRGAN ${scale}x sur CUDA…` });
    await run(paths.python, [
      paths.script, "--input", intermediate, "--output", output, "--model", options.aiModel,
      "--scale", String(scale), "--mode", options.framing === "crop" ? "prepared" : options.framing, "--crf", "17"
    ], {
      cwd: paths.root,
      signal,
      onData: text => {
        const matches = [...text.matchAll(/PROGRESS\s+(\d+)\s+(\d+)/g)];
        const match = matches.at(-1);
        if (match && Number(match[2])) {
          emit({ progress: Math.min(98, 27 + Number(match[1]) / Number(match[2]) * 71), message: `Upscale Real-ESRGAN ${scale}x sur CUDA…` });
        }
      }
    });
  } finally {
    await fs.rm(intermediate, { force: true }).catch(() => undefined);
  }
}

export async function createYouTubeShort(
  input: string,
  output: string,
  options: ShortOptions,
  context: { signal?: AbortSignal; onProgress?: (event: ShortProgress) => void } = {}
): Promise<{ duration: number; width: number; height: number }> {
  const emit = context.onProgress || (() => undefined);
  emit({ progress: 2, message: "Analyse de la video source…" });
  const info = await probe(input, context.signal);
  if (!Number.isFinite(info.duration) || info.duration <= 0) throw new Error("Impossible de determiner la duree de la video.");
  if (info.duration > MAX_DURATION_SECONDS) {
    throw new Error(`La video dure ${info.duration.toFixed(1)} s. La limite d'un Short est de 3 minutes.`);
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  try {
    if (options.upscale) await renderAi(input, output, options, info, context.signal, emit);
    else await renderStandard(input, output, options, info, context.signal, emit);
    emit({ progress: 99, message: "Validation du Short final…" });
    const final = await probe(output, context.signal);
    if (final.width !== 1080 || final.height !== 1920) throw new Error(`Format Short invalide : ${final.width} x ${final.height}.`);
    if (Math.abs(final.duration - info.duration) > 1) throw new Error("La duree du Short ne correspond pas a la video source.");
    return { duration: final.duration, width: final.width, height: final.height };
  } catch (error) {
    await fs.rm(output, { force: true }).catch(() => undefined);
    throw error;
  }
}
