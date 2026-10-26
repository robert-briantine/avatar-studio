import sharp from "sharp";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/util/asyncLoad/esm.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

export const RESOURCE_LATEX_WIDTH = 1472;
export const RESOURCE_LATEX_HEIGHT = 1104;
export const MAX_RESOURCE_LATEX_LENGTH = 8000;
export const DEFAULT_RESOURCE_LATEX_COLOR = "#17231d";

export class LatexError extends Error {
  readonly status = 400;
}

export function resourceLatexColor(value: unknown): string {
  if (value === undefined) return DEFAULT_RESOURCE_LATEX_COLOR;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new LatexError("La couleur de la formule doit être au format hexadécimal #RRGGBB.");
  }
  return value.toLowerCase();
}

function syntaxError(error: Error): LatexError {
  let detail = error.message;
  const unknown = detail.match(/Undefined control sequence (.+)/);
  const argument = detail.match(/Missing argument for (.+)/);
  if (unknown) detail = `Commande inconnue : ${unknown[1]}.`;
  else if (/Missing close brace/.test(detail)) detail = "Il manque une accolade fermante « } ».";
  else if (/Extra close brace/.test(detail)) detail = "Une accolade fermante « } » est en trop, ou une accolade ouvrante manque.";
  else if (argument) detail = `La commande ${argument[1]} attend un contenu entre accolades.`;
  else if (/Extra \\left or missing \\right/.test(detail)) detail = "Le délimiteur \\left doit être fermé par \\right.";
  return new LatexError(`Formule LaTeX invalide : ${detail}`);
}

/** Shared by resource previews and video captions; definitions stay local to one formula. */
export async function renderLatexFormula(
  content: string, width: number, height: number, fontSize: number, color = "white"
): Promise<Buffer> {
  const tex = new TeX({
    packages: ["base", "ams", "newcommand"],
    formatError: (_jax: unknown, error: Error) => { throw syntaxError(error); }
  });
  const document = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "none" }) });
  const node = await mathjax.handleRetriesFor(() => document.convert(content, {
    display: true, em: fontSize, ex: fontSize / 2, containerWidth: width
  }));
  const svg = adaptor.tags(node, "svg")[0];
  if (!svg) throw new LatexError("Le rendu LaTeX n’a produit aucune formule.");
  const bounds = adaptor.getAttribute(svg, "viewBox").split(/\s+/).map(Number);
  const scale = Math.min(fontSize / 1000, width / bounds[2], height / bounds[3]);
  if (!Number.isFinite(scale) || scale <= 0) throw new LatexError("La formule LaTeX est vide ou illisible.");
  adaptor.setAttribute(svg, "width", String(Math.max(1, Math.ceil(bounds[2] * scale))));
  adaptor.setAttribute(svg, "height", String(Math.max(1, Math.ceil(bounds[3] * scale))));
  return sharp(Buffer.from(adaptor.outerHTML(svg).replace(/currentColor/g, color))).png().toBuffer();
}

function formulaSource(source: unknown): string {
  if (typeof source !== "string") throw new LatexError("L’expression LaTeX doit être du texte.");
  if (!source.trim()) throw new LatexError("Saisissez une formule LaTeX pour afficher son aperçu.");
  if (source.length > MAX_RESOURCE_LATEX_LENGTH) throw new LatexError(`La formule est limitée à ${MAX_RESOURCE_LATEX_LENGTH} caractères.`);
  return source.trim();
}

/** A tightly fitted image for the live editor, rendered with the same TeX engine. */
export async function renderResourceLatexPreview(source: unknown, color?: unknown): Promise<Buffer> {
  return renderLatexFormula(formulaSource(source), 1200, 320, 64, resourceLatexColor(color));
}

/** A transparent, centered visual ready for the resource library. */
export async function renderResourceLatex(source: unknown, color?: unknown): Promise<Buffer> {
  const formula = await renderLatexFormula(formulaSource(source), RESOURCE_LATEX_WIDTH - 128, RESOURCE_LATEX_HEIGHT - 128, 140, resourceLatexColor(color));
  const metadata = await sharp(formula).metadata();
  return sharp({ create: { width: RESOURCE_LATEX_WIDTH, height: RESOURCE_LATEX_HEIGHT, channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: formula, left: Math.floor((RESOURCE_LATEX_WIDTH - metadata.width!) / 2),
      top: Math.floor((RESOURCE_LATEX_HEIGHT - metadata.height!) / 2) }]).png({ compressionLevel: 6 }).toBuffer();
}
