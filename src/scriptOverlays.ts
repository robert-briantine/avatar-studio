import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/util/asyncLoad/esm.js";
import type { VoiceAsset } from "./avatarStore.js";
import { hasScriptVisuals, parseAvatarScript, type AvatarScript, type AvatarScriptTiming } from "./avatarScript.js";
import { overlayVideoImages, probeDuration, probeVideoSize, validateScriptVideo } from "./media.js";

export type TimedScriptOverlay = {
  mode: "text" | "latex";
  content: string;
  start: number;
  end: number;
};

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

/** Validate the plan belonging to the actual WAV, including historical renders. */
export function getScriptTimings(voice: VoiceAsset): AvatarScriptTiming[] {
  const script = voice.script;
  if (!script || !hasScriptVisuals(script)) return [];
  const timings = voice.scriptTimings;
  const invalid = () => new RangeError(
    "Les repères de narration sont absents ou invalides. Régénère la voix pour synchroniser les visuels."
  );
  if (!Array.isArray(timings) || timings.length !== script.sequences.length) throw invalid();
  let end = 0;
  for (const index of script.sequences.keys()) {
    const timing = timings[index];
    if (!timing || timing.sequenceIndex !== index || !Number.isFinite(timing.start) || !Number.isFinite(timing.end) || timing.start < 0
      || Math.abs(timing.start - end) > 1 / 48000 || timing.end <= timing.start) throw invalid();
    end = timing.end;
  }
  if (voice.duration !== undefined && (!Number.isFinite(voice.duration) || Math.abs(end - voice.duration) > 0.001)) throw invalid();
  return timings;
}

export function getScriptOverlays(voice: VoiceAsset): TimedScriptOverlay[] {
  const timings = getScriptTimings(voice);
  return timings.flatMap(timing => {
    const sequence = voice.script!.sequences[timing.sequenceIndex];
    return sequence.mode === "text" || sequence.mode === "latex"
      ? [{ mode: sequence.mode, content: sequence.content, start: timing.start, end: timing.end }]
      : [];
  });
}

function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[character]!);
}

async function renderFormula(content: string, width: number, height: number, fontSize: number): Promise<Buffer> {
  // A fresh input jax isolates definitions between formulas. Only local TeX
  // packages are loaded: formulas cannot request files, HTML or remote URLs.
  const tex = new TeX({
    packages: ["base", "ams", "newcommand"],
    formatError: (_jax: unknown, error: Error) => { throw new Error(`Formule LaTeX invalide : ${error.message}`); }
  });
  const document = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "none" }) });
  const node = await mathjax.handleRetriesFor(() => document.convert(content, {
    display: true, em: fontSize, ex: fontSize / 2, containerWidth: width
  }));
  const svg = adaptor.tags(node, "svg")[0];
  if (!svg) throw new Error("Le rendu LaTeX n’a produit aucune formule.");
  const bounds = adaptor.getAttribute(svg, "viewBox").split(/\s+/).map(Number);
  const scale = Math.min(fontSize / 1000, width / bounds[2], height / bounds[3]);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("La formule LaTeX est vide ou illisible.");
  adaptor.setAttribute(svg, "width", String(Math.max(1, Math.ceil(bounds[2] * scale))));
  adaptor.setAttribute(svg, "height", String(Math.max(1, Math.ceil(bounds[3] * scale))));
  const serialized = adaptor.outerHTML(svg).replace(/currentColor/g, "white");
  return sharp(Buffer.from(serialized)).png().toBuffer();
}

/** Render-check captions locally before any TTS, image or Wan inference. */
export async function validateScriptOverlays(script: AvatarScript): Promise<void> {
  const seen = new Set<string>();
  for (const sequence of script.sequences) {
    if (sequence.mode !== "text" && sequence.mode !== "latex") continue;
    const key = `${sequence.mode}\0${sequence.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try { await renderScriptOverlay(sequence.mode, sequence.content, 1024, 512); }
    catch (error) { throw new RangeError(`Incrustation invalide : ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/** Old or edited saved plans must still describe the words actually synthesized. */
export async function validateVoiceScript(voice: VoiceAsset, expectedSource?: string): Promise<void> {
  if (!voice.script) return;
  if (typeof voice.script.source !== "string" || typeof voice.script.narration !== "string"
    || !Array.isArray(voice.script.sequences)) throw new RangeError("Scénario enregistré invalide. Régénère la voix.");
  if (expectedSource !== undefined && expectedSource !== voice.script.source) {
    throw new RangeError("Le texte de cette génération ne correspond plus à sa voix. Régénère la voix.");
  }
  let parsed: AvatarScript;
  try { parsed = parseAvatarScript(voice.script.source); }
  catch (error) { throw new RangeError(`${error instanceof Error ? error.message : String(error)} Régénère la voix.`); }
  if (parsed.narration !== voice.text || parsed.narration !== voice.script.narration
    || parsed.sequences.length !== voice.script.sequences.length
    || parsed.sequences.some((sequence, index) => {
      const saved = voice.script!.sequences[index];
      return !saved || typeof saved !== "object" || sequence.mode !== saved.mode || sequence.text !== saved.text
        || ("content" in sequence && (!("content" in saved) || sequence.content !== saved.content));
    })) throw new RangeError("Le scénario enregistré ne correspond plus à la voix. Régénère la voix.");
  await validateScriptOverlays(parsed);
  const timings = getScriptTimings(voice);
  const expectedDuration = timings.at(-1)?.end ?? voice.duration;
  if (expectedDuration !== undefined) {
    let actual: number;
    try { actual = await probeDuration(voice.path); }
    catch { throw new RangeError("La voix enregistrée est absente ou illisible. Régénère la voix."); }
    if (!Number.isFinite(expectedDuration) || Math.abs(actual - expectedDuration) > 0.001) {
      throw new RangeError("La durée de la voix ne correspond plus aux repères enregistrés. Régénère la voix.");
    }
  }
}

/** A fitted, centered caption on a translucent panel at the bottom of a frame. */
export async function renderScriptOverlay(
  mode: "text" | "latex", content: string, width: number, height: number
): Promise<Buffer> {
  const maxWidth = Math.max(1, Math.floor(width * 0.84));
  const maxHeight = Math.max(1, Math.floor(height * 0.28));
  const fontSize = Math.max(12, Math.round(Math.min(height * 0.055, width * 0.045)));
  const rendered = mode === "latex"
    ? await renderFormula(content, maxWidth, maxHeight, fontSize)
    : await sharp({ text: {
      text: `<span foreground="white">${escapeMarkup(content)}</span>`,
      font: `DejaVu Sans Bold ${fontSize}`, width: maxWidth, align: "centre", wrap: "word-char", rgba: true
    } }).png().toBuffer();
  const { data, info } = await sharp(rendered).resize({
    width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true
  }).png().toBuffer({ resolveWithObject: true });
  const padding = Math.max(2, Math.round(Math.min(width, height) * 0.025));
  const panelWidth = info.width + padding * 2;
  const panelHeight = info.height + padding * 2;
  const panel = await sharp({ create: {
    width: panelWidth, height: panelHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.62 }
  } }).composite([{ input: data, left: padding, top: padding }]).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{
      input: panel, left: Math.round((width - panelWidth) / 2),
      top: height - panelHeight - Math.round(height * 0.06)
    }]).png().toBuffer();
}

/** Replace output only after success; preserve the input if rendering fails. */
export async function applyScriptOverlays(
  inputPath: string, outputPath: string, overlays: TimedScriptOverlay[], signal?: AbortSignal, expectedDuration?: number
): Promise<void> {
  signal?.throwIfAborted();
  if (!overlays.length && path.resolve(inputPath) === path.resolve(outputPath)) {
    if (expectedDuration !== undefined) await validateScriptVideo(inputPath, expectedDuration, signal);
    return;
  }
  const directory = await fs.mkdtemp(path.join(path.dirname(outputPath), ".avatar-overlays-"));
  try {
    const target = path.join(directory, "result.mp4");
    if (!overlays.length) {
      await fs.copyFile(inputPath, target);
    } else {
      const { width, height } = await probeVideoSize(inputPath, signal);
      const images: Array<{ path: string; start: number; end: number }> = [];
      for (const [index, overlay] of overlays.entries()) {
        signal?.throwIfAborted();
        if (!Number.isFinite(overlay.start) || !Number.isFinite(overlay.end) || overlay.start < 0 || overlay.end <= overlay.start) {
          throw new RangeError("Bornes d’incrustation invalides.");
        }
        const imagePath = path.join(directory, `${index}.png`);
        await fs.writeFile(imagePath, await renderScriptOverlay(overlay.mode, overlay.content, width, height));
        images.push({ path: imagePath, start: overlay.start, end: overlay.end });
      }
      await overlayVideoImages(inputPath, target, images, signal);
    }
    if (expectedDuration !== undefined) await validateScriptVideo(target, expectedDuration, signal);
    signal?.throwIfAborted();
    await fs.rename(target, outputPath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
