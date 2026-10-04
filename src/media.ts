import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { WAN_S2V_FPS, type WanVideoWindow } from "./wanS2V.js";

function abortError(): Error {
  const error = new Error("Opération arrêtée par l'utilisateur");
  error.name = "AbortError";
  return error;
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    const onAbort = () => {
      stopped = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1200).unref();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", code => {
      signal?.removeEventListener("abort", onAbort);
      if (stopped || signal?.aborted) return reject(abortError());
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-4000)}`));
    });
  });
}

export async function mediaHealth(): Promise<{ ok: boolean; ffmpeg: boolean; ffprobe: boolean; error?: string }> {
  let ffmpeg = false;
  let ffprobe = false;
  try { await run("ffmpeg", ["-version"]); ffmpeg = true; } catch {}
  try { await run("ffprobe", ["-version"]); ffprobe = true; } catch {}
  return { ok: ffmpeg && ffprobe, ffmpeg, ffprobe, error: ffmpeg && ffprobe ? undefined : "FFmpeg/ffprobe manquant. Installe: sudo apt install -y ffmpeg" };
}

export async function probeDuration(filePath: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], signal);
  const value = Number(stdout.trim());
  if (!Number.isFinite(value)) throw new Error(`Durée illisible pour ${filePath}`);
  return value;
}

const ttsLoudnessFilter = "loudnorm=I=-18:LRA=11:TP=-2.0";

async function writeFinalTtsAudio(
  inputPath: string,
  outputPath: string,
  trimEnd?: number,
  signal?: AbortSignal
): Promise<void> {
  const filters = trimEnd === undefined
    ? [ttsLoudnessFilter]
    : [`atrim=end=${trimEnd.toFixed(6)}`, "asetpts=N/SR/TB", ttsLoudnessFilter];
  await run("ffmpeg", [
    "-y", "-i", inputPath,
    "-af", filters.join(","),
    "-ar", "48000",
    "-c:a", "pcm_s16le", outputPath
  ], signal);
}

export async function processAudio(inputPath: string, outputPath: string, filter?: string, signal?: AbortSignal): Promise<void> {
  // v5.35 — NON-DESTRUCTIVE TTS tail handling.
  // Never run silenceremove over a normal phrase: it can classify a quiet final
  // consonant/breath as silence and make the voice sound cut.
  //
  // 1. Apply only the requested voice/speed filter to a temporary PCM WAV.
  // 2. Detect a REAL trailing silence >= 2.0 seconds.
  // 3. Trim only that pathological tail, keeping 350 ms after silence_start.
  // 4. Normalize voice playback level and cap true peak at -2 dBTP. No gain
  //    affects the silence detector or the protected source WAV.
  const tempPath = path.join(
    path.dirname(outputPath),
    `.tts-processed-${randomUUID()}${path.extname(outputPath) || ".wav"}`
  );

  try {
    const args = ["-y", "-i", inputPath];
    if (filter) args.push("-af", filter);
    args.push("-c:a", "pcm_s16le", tempPath);
    await run("ffmpeg", args, signal);

    const totalDuration = await probeDuration(tempPath, signal);
    const silences = await detectSilences(tempPath, signal, 2.0, -68);
    const trailing = silences
      .filter(s => s.end >= totalDuration - 0.08 && s.duration >= 2.0)
      .sort((a, b) => b.end - a.end)[0];

    if (!trailing) {
      console.log(`[audio] fin naturelle conservée intégralement — durée=${totalDuration.toFixed(3)}s`);
      await writeFinalTtsAudio(tempPath, outputPath, undefined, signal);
      return;
    }

    const keepUntil = Math.min(totalDuration, trailing.start + 0.35);
    console.log(
      `[audio] long silence final détecté — durée totale=${totalDuration.toFixed(3)}s, ` +
      `silence=${trailing.duration.toFixed(3)}s, coupe sûre à ${keepUntil.toFixed(3)}s`
    );

    await writeFinalTtsAudio(tempPath, outputPath, keepUntil, signal);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}


export async function concatWavs(
  wavPaths: string[],
  outputPath: string,
  signal?: AbortSignal
): Promise<number> {
  if (!wavPaths.length) throw new Error("Aucun WAV à assembler");
  if (wavPaths.length === 1) {
    await fs.copyFile(wavPaths[0], outputPath);
    return probeDuration(outputPath, signal);
  }

  const listPath = path.join(path.dirname(outputPath), `.concat-wav-${randomUUID()}.txt`);
  await fs.writeFile(
    listPath,
    wavPaths.map(p => `file '${escapeConcatPath(path.resolve(p))}'`).join("\n")
  );

  try {
    // Decode/re-encode as PCM only; no AAC boundary and no artificial gap.
    await run(
      "ffmpeg",
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c:a", "pcm_s16le",
        outputPath
      ],
      signal
    );
  } finally {
    await fs.rm(listPath, { force: true });
  }

  return probeDuration(outputPath, signal);
}

export async function createSilence(outputPath: string, seconds = config.video.silentSeconds, signal?: AbortSignal): Promise<void> {
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(Math.max(0.2, seconds)), "-c:a", "pcm_s16le", outputPath], signal);
}

export async function createSegmentVideo(imagePath: string, audioPath: string, outputPath: string, signal?: AbortSignal): Promise<number> {
  const duration = await probeDuration(audioPath, signal);
  const vf = [`scale=${config.video.width}:${config.video.height}:force_original_aspect_ratio=decrease`, `pad=${config.video.width}:${config.video.height}:(ow-iw)/2:(oh-ih)/2:black`, "format=yuv420p"].join(",");
  await run("ffmpeg", [
    "-y", "-loop", "1", "-framerate", String(config.video.fps), "-i", imagePath, "-i", audioPath,
    "-t", duration.toFixed(3), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
    "-r", String(config.video.fps), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", outputPath
  ], signal);
  return duration;
}

function escapeConcatPath(value: string): string { return value.replace(/'/g, "'\\''"); }

export async function concatVideos(segmentPaths: string[], outputPath: string, signal?: AbortSignal): Promise<number> {
  if (segmentPaths.length === 0) throw new Error("Aucun segment vidéo à assembler");
  const listPath = path.join(path.dirname(outputPath), `.concat-${randomUUID()}.txt`);
  await fs.writeFile(listPath, segmentPaths.map(p => `file '${escapeConcatPath(path.resolve(p))}'`).join("\n"));

  try {
    try {
      // IMPORTANT: do not stream-copy AAC from independently encoded segments.
      // Each segment has its own AAC priming/padding. Concatenating those packets
      // directly can create a tiny audible discontinuity at every boundary.
      //
      // Keep the H.264 video bit-for-bit, but decode all segment audio and encode
      // ONE continuous AAC stream for the final movie. aresample also normalizes
      // tiny timestamp gaps without modifying the intended 450ms tails.
      await run("ffmpeg", [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-af", "aresample=async=1:first_pts=0",
        "-movflags", "+faststart",
        outputPath
      ], signal);
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;

      // Fallback: if video stream-copy is impossible for any reason, encode both
      // streams, still keeping a single continuous AAC encoder for the soundtrack.
      await run("ffmpeg", [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-af", "aresample=async=1:first_pts=0",
        "-movflags", "+faststart",
        outputPath
      ], signal);
    }
  } finally {
    await fs.rm(listPath, { force: true });
  }

  return probeDuration(outputPath, signal);
}


/**
 * Assemble the final movie from:
 *   - VIDEO: the already-rendered MP4 segments (video stream only)
 *   - AUDIO: the original processed WAV files, concatenated directly
 *
 * This completely bypasses the AAC tracks embedded in individual segments.
 * Therefore AAC encoder priming/padding from N independently encoded segments
 * cannot create N-1 audible boundaries in the final movie.
 */
export async function concatVideosWithWavMaster(
  segmentPaths: string[],
  wavPaths: string[],
  outputPath: string,
  signal?: AbortSignal
): Promise<number> {
  if (segmentPaths.length === 0) throw new Error("Aucun segment vidéo à assembler");
  if (segmentPaths.length !== wavPaths.length) {
    throw new Error(`Nombre de segments (${segmentPaths.length}) différent du nombre de WAV (${wavPaths.length})`);
  }

  const dir = path.dirname(outputPath);
  const videoListPath = path.join(dir, `.concat-video-${randomUUID()}.txt`);
  const audioListPath = path.join(dir, `.concat-audio-${randomUUID()}.txt`);

  await Promise.all([
    fs.writeFile(
      videoListPath,
      segmentPaths.map(p => `file '${escapeConcatPath(path.resolve(p))}'`).join("\n")
    ),
    fs.writeFile(
      audioListPath,
      wavPaths.map(p => `file '${escapeConcatPath(path.resolve(p))}'`).join("\n")
    )
  ]);

  try {
    try {
      // Input 0 supplies VIDEO ONLY from MP4 segments.
      // Input 1 supplies the continuous narration directly from PCM WAV files.
      // One and only one AAC encoder is used, at the very end.
      await run("ffmpeg", [
        "-y",
        "-f", "concat", "-safe", "0", "-i", videoListPath,
        "-f", "concat", "-safe", "0", "-i", audioListPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-af", "aresample=48000:async=1:first_pts=0",
        "-movflags", "+faststart",
        "-shortest",
        outputPath
      ], signal);
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;

      // Fallback if H.264 stream-copy cannot be used.
      await run("ffmpeg", [
        "-y",
        "-f", "concat", "-safe", "0", "-i", videoListPath,
        "-f", "concat", "-safe", "0", "-i", audioListPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-af", "aresample=48000:async=1:first_pts=0",
        "-movflags", "+faststart",
        "-shortest",
        outputPath
      ], signal);
    }
  } finally {
    await Promise.all([
      fs.rm(videoListPath, { force: true }),
      fs.rm(audioListPath, { force: true })
    ]);
  }

  return probeDuration(outputPath, signal);
}



function atempoChain(speed: number): string {
  const parts: number[] = [];
  let remaining = speed;
  while (remaining > 2.0) { parts.push(2.0); remaining /= 2.0; }
  while (remaining < 0.5) { parts.push(0.5); remaining /= 0.5; }
  parts.push(remaining);
  return parts.map(v => `atempo=${v.toFixed(6)}`).join(",");
}

export async function speedVideo(inputPath: string, outputPath: string, speed: number, signal?: AbortSignal): Promise<number> {
  const s = Math.max(0.25, Math.min(4, speed));
  const filter = `[0:v]setpts=PTS/${s.toFixed(6)}[v];[0:a]${atempoChain(s)}[a]`;
  await run("ffmpeg", ["-y", "-i", inputPath, "-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath], signal);
  return probeDuration(outputPath, signal);
}


export type SilenceInterval = {
  start: number;
  end: number;
  duration: number;
};

export type NarrationBoundary = {
  index: number;
  expectedTime: number;
  cutTime: number;
  previousEndTime: number;
  nextStartTime: number;
  silenceStart: number;
  silenceEnd: number;
  silenceDuration: number;
  removedSilence: number;
  positionError: number;
};

export async function detectSilences(
  filePath: string,
  signal?: AbortSignal,
  minDuration = 0.20,
  noiseDb = -38
): Promise<SilenceInterval[]> {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", filePath,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
    "-f", "null",
    "-"
  ], signal);

  const intervals: SilenceInterval[] = [];
  let pendingStart: number | undefined;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch && pendingStart !== undefined) {
      const end = Number(endMatch[1]);
      const duration = Number(endMatch[2]);
      if (Number.isFinite(end) && Number.isFinite(duration) && end > pendingStart) {
        intervals.push({ start: pendingStart, end, duration });
      }
      pendingStart = undefined;
    }
  }

  if (pendingStart !== undefined) {
    const total = await probeDuration(filePath, signal);
    if (total > pendingStart) {
      intervals.push({ start: pendingStart, end: total, duration: total - pendingStart });
    }
  }

  return intervals;
}

function spokenWeight(text: string): number {
  const normalized = text
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalized) return 1;
  const words = normalized.split(/\s+/).filter(Boolean);
  // Word count is more stable than character count for estimated speaking time.
  return Math.max(1, words.length);
}

export function alignNarrationBoundaries(
  texts: string[],
  totalDuration: number,
  silences: SilenceInterval[]
): NarrationBoundary[] {
  if (texts.length <= 1) return [];
  const required = texts.length - 1;

  const MIN_BOUNDARY_SILENCE = 0.45;
  const candidates = silences
    .filter(s =>
      s.duration >= MIN_BOUNDARY_SILENCE &&
      s.start > 0.12 &&
      s.end < totalDuration - 0.12
    )
    .map(s => ({
      ...s,
      center: (s.start + s.end) / 2
    }));

  if (candidates.length < required) {
    throw new Error(
      `Découpage vocal précis impossible: ${required} frontière(s) attendue(s), ` +
      `mais seulement ${candidates.length} silence(s) long(s) (>= 0,45 s) détecté(s). ` +
      `Aucune coupe approximative n'a été effectuée afin de ne jamais tronquer une phrase.`
    );
  }

  const weights = texts.map(spokenWeight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const expectedRatios: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    cumulative += weights[i];
    expectedRatios.push(cumulative / totalWeight);
  }

  // Dynamic programming: choose ordered silences. We strongly prefer long
  // silences, but keep them close to the expected textual boundary.
  const m = required;
  const n = candidates.length;
  const INF = 1e30;
  const dp = Array.from({ length: m }, () => Array(n).fill(INF));
  const prev = Array.from({ length: m }, () => Array(n).fill(-1));

  const localCost = (boundaryIndex: number, candidateIndex: number) => {
    const c = candidates[candidateIndex];
    const ratio = c.center / totalDuration;
    const distance = Math.abs(ratio - expectedRatios[boundaryIndex]);
    // Real detected silence is more trustworthy than textual duration estimation.
    // Qwen's speaking rate varies by phrase, so expected textual position is only
    // a soft hint. Long silences dominate the score.
    const durationReward = Math.min(c.duration, 3.0) * 0.85;
    return distance * 2.5 - durationReward;
  };

  for (let j = 0; j < n; j++) {
    dp[0][j] = localCost(0, j);
  }

  for (let i = 1; i < m; i++) {
    let bestCost = INF;
    let bestIndex = -1;
    for (let j = 0; j < n; j++) {
      if (j > 0 && dp[i - 1][j - 1] < bestCost) {
        bestCost = dp[i - 1][j - 1];
        bestIndex = j - 1;
      }
      if (bestIndex >= 0) {
        dp[i][j] = bestCost + localCost(i, j);
        prev[i][j] = bestIndex;
      }
    }
  }

  let last = -1;
  let best = INF;
  for (let j = 0; j < n; j++) {
    if (dp[m - 1][j] < best) {
      best = dp[m - 1][j];
      last = j;
    }
  }
  if (last < 0) throw new Error("Impossible d'aligner les silences de la narration");

  const selected = new Array<number>(m);
  for (let i = m - 1; i >= 0; i--) {
    selected[i] = last;
    last = prev[i][last];
  }

  const result = selected.map((candidateIndex, i) => {
    const c = candidates[candidateIndex];
    const expectedTime = expectedRatios[i] * totalDuration;
    const positionError = Math.abs(c.center - expectedTime) / totalDuration;
    // Keep a very small tail after the previous phrase and a very small
    // pre-roll before the next phrase. The middle of the separator silence is
    // dropped completely. This makes the image transition line up with speech.
    const previousEndTime = Math.min(c.end - 0.10, c.start + 0.06);
    const nextStartTime = Math.max(previousEndTime + 0.02, c.end - 0.08);
    const cutTime = (previousEndTime + nextStartTime) / 2;
    return {
      index: i,
      expectedTime,
      cutTime,
      previousEndTime,
      nextStartTime,
      silenceStart: c.start,
      silenceEnd: c.end,
      silenceDuration: c.duration,
      removedSilence: Math.max(0, nextStartTime - previousEndTime),
      positionError
    };
  });

  // Precision guard: never silently cut at a suspicious location.
  for (const b of result) {
    if (b.silenceDuration < 0.45 || b.positionError > 0.35) {
      throw new Error(
        `Frontière ${b.index + 1} jugée incertaine: silence=${b.silenceDuration.toFixed(3)}s, ` +
        `écart=${(b.positionError * 100).toFixed(1)}%. ` +
        `Même avec la tolérance renforcée, la frontière est trop ambiguë pour couper sans risque.`
      );
    }
  }

  return result;
}

export async function splitWavAtBoundaries(
  inputPath: string,
  outputPaths: string[],
  boundaries: NarrationBoundary[],
  signal?: AbortSignal
): Promise<number[]> {
  if (outputPaths.length !== boundaries.length + 1) {
    throw new Error("Nombre de sorties incompatible avec les frontières audio");
  }

  const total = await probeDuration(inputPath, signal);
  const durations: number[] = [];

  for (let i = 0; i < outputPaths.length; i++) {
    // IMPORTANT: a boundary has TWO times.
    // The previous sequence stops near the start of the silence.
    // The next sequence starts near the end of the same silence.
    // The unused middle silence is intentionally removed.
    const start = i === 0 ? 0 : boundaries[i - 1].nextStartTime;
    const end = i === outputPaths.length - 1 ? total : boundaries[i].previousEndTime;

    if (!(end > start)) {
      throw new Error(`Découpage audio invalide pour la séquence ${i + 1}: start=${start.toFixed(3)} end=${end.toFixed(3)}`);
    }

    const segmentDuration = end - start;
    const fade = Math.min(0.015, segmentDuration / 8);
    const fadeOutStart = Math.max(0, segmentDuration - fade);

    // Sample-accurate cut from PCM WAV. Tiny fades only prevent clicks at the
    // edit point; they are much shorter than a phoneme and do not affect words.
    const filter = [
      `atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)}`,
      "asetpts=PTS-STARTPTS",
      `afade=t=in:st=0:d=${fade.toFixed(6)}`,
      `afade=t=out:st=${fadeOutStart.toFixed(6)}:d=${fade.toFixed(6)}`
    ].join(",");

    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-y", "-i", inputPath,
      "-af", filter,
      "-c:a", "pcm_s16le",
      outputPaths[i]
    ], signal);

    durations.push(await probeDuration(outputPaths[i], signal));
  }

  return durations;
}


export async function extractAudioSegment(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
  signal?: AbortSignal
): Promise<number> {
  await run("ffmpeg", [
    "-y", "-ss", startSeconds.toFixed(6), "-i", inputPath,
    "-t", durationSeconds.toFixed(6),
    "-vn", "-c:a", "pcm_s16le", outputPath
  ], signal);
  return probeDuration(outputPath, signal);
}

export async function trimVideoDuration(
  inputPath: string,
  outputPath: string,
  durationSeconds: number,
  signal?: AbortSignal
): Promise<number> {
  await run("ffmpeg", [
    "-y", "-i", inputPath,
    "-t", durationSeconds.toFixed(6),
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath
  ], signal);
  return probeDuration(outputPath, signal);
}

const wanTransitionScript = fileURLToPath(new URL("../scripts/blend-wan-transitions.py", import.meta.url));

export async function checkWanTransitions(): Promise<void> {
  try {
    await run(config.video.transitionPython, [wanTransitionScript, "--check"]);
  } catch (error) {
    throw new Error(`Raccords vidéo indisponibles : configure WAN_TRANSITION_PYTHON avec un Python équipé d'OpenCV et NumPy. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function assembleWanVideo(
  inputPath: string, audioPath: string, outputPath: string, durationSeconds: number,
  windows?: WanVideoWindow[], referencePath?: string, signal?: AbortSignal
): Promise<number> {
  if (!referencePath && !windows?.length) {
    return trimVideoDuration(inputPath, outputPath, durationSeconds, signal);
  }
  const assemblyWindows = windows?.length
    ? windows
    : [{ startFrame: 0, frames: Math.ceil(durationSeconds * WAN_S2V_FPS) }];
  const temporary = path.join(path.dirname(outputPath), `.wan-transitions-${randomUUID()}.mp4`);
  try {
    const args = [
      wanTransitionScript, "--input", inputPath, "--audio", audioPath, "--output", temporary,
      "--windows", JSON.stringify(assemblyWindows), "--duration", String(durationSeconds), "--fps", String(WAN_S2V_FPS)
    ];
    if (referencePath) args.push("--reference", referencePath);
    await run(config.video.transitionPython, args, signal);
    const duration = await probeDuration(temporary, signal);
    await fs.rename(temporary, outputPath);
    return duration;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
