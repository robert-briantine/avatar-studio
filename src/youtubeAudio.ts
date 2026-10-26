import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { probeDuration } from "./media.js";
import { MIN_VOICE_FINGERPRINT_SECONDS } from "./voiceFingerprint.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"]);

export function parseYouTubeUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new Error("Saisissez un lien vidéo YouTube valide."); }
  if (!["http:", "https:"].includes(url.protocol) || !hosts.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error("Utilisez un lien youtube.com ou youtu.be.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const id = url.hostname.endsWith("youtu.be") && parts.length === 1 ? parts[0]
    : url.pathname === "/watch" ? url.searchParams.get("v")
    : ["shorts", "embed", "live"].includes(parts[0]) && parts.length === 2 ? parts[1] : null;
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new Error("Le lien doit désigner une vidéo YouTube, pas une chaîne ou une playlist.");
  return `https://www.youtube.com/watch?v=${id}`;
}

export function parseAudioTimestamp(value: unknown): number {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(",", ".") : "";
  const parts = raw.split(":");
  const valid = parts.length <= 3 && parts.every((part, index) =>
    (index === parts.length - 1 ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/).test(part)
    && (parts.length === 1 || index === 0 || Number(part) < 60));
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (!valid || !Number.isSafeInteger(Math.ceil(seconds)) || seconds < 0) {
    throw new Error("Repère temporel invalide. Utilisez des secondes, mm:ss ou hh:mm:ss (ex. 01:30).");
  }
  return seconds;
}

export async function extractYouTubeVoice(
  url: string, startSeconds: number, outputPath: string, signal?: AbortSignal
): Promise<{ duration: number; title: string }> {
  // Validate again at the network boundary; never pass arbitrary sites to yt-dlp.
  const canonical = parseYouTubeUrl(url);
  parseAudioTimestamp(startSeconds);
  const localTool = path.join(root, ".tools", "yt-dlp");
  const tool = process.env.YT_DLP_PATH?.trim() || (existsSync(localTool) ? localTool : "yt-dlp");
  let metadata: { title?: string; duration?: number; is_live?: boolean; live_status?: string; url?: string; http_headers?: Record<string, string> };
  try {
    const { stdout } = await exec(tool, [
      "--ignore-config", "--no-playlist", "--no-progress", "--no-warnings", "--no-cache-dir",
      "--js-runtimes", `node:${process.execPath}`, "--socket-timeout", "15", "--retries", "1", "--extractor-retries", "1",
      "--dump-single-json", "--skip-download", "--format", "bestaudio/best", "--", canonical
    ], { signal, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
    metadata = JSON.parse(stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("L’import YouTube n’est pas installé sur ce serveur. Lancez : bash scripts/install-youtube-audio.sh");
    }
    throw new Error("Impossible d’accéder au son de cette vidéo YouTube. Vérifiez que la vidéo est publique et disponible, puis réessayez.");
  }
  if (metadata.is_live || ["is_live", "is_upcoming"].includes(metadata.live_status || "")) {
    throw new Error("Choisissez une vidéo terminée : l’extraction depuis un direct ou une première à venir n’est pas disponible.");
  }
  if (typeof metadata.duration !== "number" || !Number.isFinite(metadata.duration) || startSeconds + MIN_VOICE_FINGERPRINT_SECONDS > metadata.duration) {
    throw new Error(`Il faut au moins ${MIN_VOICE_FINGERPRINT_SECONDS} secondes de son après le repère choisi. Choisissez un début plus tôt dans la vidéo.`);
  }
  let stream: URL;
  try { stream = new URL(metadata.url || ""); }
  catch { throw new Error("La vidéo ne fournit aucune piste audio exploitable."); }
  if (!["http:", "https:"].includes(stream.protocol)) throw new Error("La vidéo ne fournit aucune piste audio exploitable.");
  const headers = Object.entries(metadata.http_headers || {})
    .filter(([key, value]) => /^[a-zA-Z0-9-]+$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value))
    .map(([key, value]) => `${key}: ${value}\r\n`).join("");
  try {
    await exec("ffmpeg", [
      "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "http,https,tls,tcp,crypto",
      "-rw_timeout", "15000000", ...(headers ? ["-headers", headers] : []),
      "-ss", String(startSeconds), "-i", stream.href, "-t", String(MIN_VOICE_FINGERPRINT_SECONDS),
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", outputPath
    ], { signal, timeout: 60_000 });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Le téléchargement de l’extrait audio a échoué. Vérifiez le lien et réessayez.");
  }
  const duration = await probeDuration(outputPath, signal);
  if (Math.round(duration * 24000) !== MIN_VOICE_FINGERPRINT_SECONDS * 24000) {
    throw new Error(`L’extrait récupéré est incomplet. Choisissez un repère avec ${MIN_VOICE_FINGERPRINT_SECONDS} secondes de son disponibles.`);
  }
  return { duration, title: metadata.title?.trim() || "Vidéo YouTube" };
}
