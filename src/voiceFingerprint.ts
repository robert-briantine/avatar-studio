import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeDuration } from "./media.js";

export const MIN_VOICE_FINGERPRINT_SECONDS = 3;
export const MAX_VOICE_UPLOAD_BYTES = 30 * 1024 * 1024;
const exec = promisify(execFile);

/** Measure decoded audio, rather than trusting the upload's MIME type or metadata. */
export async function prepareVoiceFingerprintAudio(
  inputPath: string, outputPath: string, signal?: AbortSignal
): Promise<number> {
  try {
    await exec("ffmpeg", [
      "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", inputPath,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", outputPath
    ], { signal, timeout: 60_000 });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Impossible de lire ce fichier audio. Utilisez un fichier WAV, MP3, FLAC, M4A, OGG ou AAC valide.");
  }
  const duration = await probeDuration(outputPath, signal);
  if (!Number.isFinite(duration) || duration < MIN_VOICE_FINGERPRINT_SECONDS) {
    throw new Error(`Le fichier audio doit durer au moins ${MIN_VOICE_FINGERPRINT_SECONDS} secondes (durée détectée : ${duration.toFixed(2)} s).`);
  }
  return duration;
}
