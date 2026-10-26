import sharp from "sharp";
import { renderResourceCodeContent } from "./resourceCode.js";

export const compositionPositions = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const;
export type ResourceComposition = {
  position: typeof compositionPositions[number];
  sizePercent: number;
  margin: number;
  backgroundFit: "contain" | "cover";
};
export const defaultComposition: ResourceComposition = { position: "center", sizePercent: 80, margin: 64, backgroundFit: "contain" };

export class CompositionError extends Error { readonly status = 400; }

export function resourceComposition(value: unknown): ResourceComposition {
  if (value === undefined) return { ...defaultComposition };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompositionError("Les réglages de composition sont invalides.");
  const result = { ...defaultComposition, ...value } as ResourceComposition;
  if (!compositionPositions.includes(result.position)) throw new CompositionError("Choisissez une position valide pour le contenu.");
  if (!Number.isInteger(result.sizePercent) || result.sizePercent < 30 || result.sizePercent > 90) throw new CompositionError("La taille du contenu doit être comprise entre 30 et 90 %.");
  if (!Number.isInteger(result.margin) || result.margin < 16 || result.margin > 160) throw new CompositionError("La marge doit être comprise entre 16 et 160 pixels.");
  if (!["contain", "cover"].includes(result.backgroundFit)) throw new CompositionError("Choisissez un cadrage valide pour l’image de fond.");
  return { position: result.position, sizePercent: result.sizePercent, margin: result.margin, backgroundFit: result.backgroundFit };
}

/** One compositor for live previews, stored visuals and subsequent video use. */
export async function composeResourceVisual(
  resource: { type: "latex" | "typescript" | "diagram"; source: string; codeTheme?: string; composition?: ResourceComposition },
  foreground: Buffer, background: Buffer
): Promise<Buffer> {
  const { position, sizePercent, margin, backgroundFit } = resourceComposition(resource.composition);
  const width = 1472, height = 1104, padding = resource.type === "typescript" ? 24 : 0;
  const content = resource.type === "typescript"
    ? await renderResourceCodeContent(resource.source, resource.codeTheme)
    : await sharp(foreground).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 }).png().toBuffer();
  const maxWidth = Math.floor((width - margin * 2) * sizePercent / 100);
  const maxHeight = Math.floor((height - margin * 2) * sizePercent / 100);
  const fitted = await sharp(content).resize({ width: maxWidth - padding * 2, height: maxHeight - padding * 2, fit: "inside" })
    .ensureAlpha().png().toBuffer({ resolveWithObject: true });
  const panelWidth = fitted.info.width + padding * 2, panelHeight = fitted.info.height + padding * 2;
  let panel = fitted.data;
  if (resource.type === "typescript") {
    const panelColor = resource.codeTheme !== "light-plus" ? "#1e1e1e" : "#ffffff";
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${panelHeight}"><rect width="100%" height="100%" rx="16" fill="white"/></svg>`);
    panel = await sharp({ create: { width: panelWidth, height: panelHeight, channels: 4, background: panelColor } })
      .composite([{ input: fitted.data, left: padding, top: padding }, { input: mask, blend: "dest-in" }]).png().toBuffer();
  }
  const left = position.endsWith("left") || position === "left" ? margin
    : position.endsWith("right") || position === "right" ? width - margin - panelWidth : Math.floor((width - panelWidth) / 2);
  const top = position.startsWith("top") ? margin
    : position.startsWith("bottom") ? height - margin - panelHeight : Math.floor((height - panelHeight) / 2);
  const canvas = await sharp(background, { limitInputPixels: 40_000_000 }).rotate().flatten({ background: "#13261e" })
    .resize({ width, height, fit: backgroundFit, position: "centre", background: "#13261e" }).png().toBuffer();
  return sharp(canvas).composite([{ input: panel, left, top }]).png().toBuffer();
}
