import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import sharp from "sharp";
import { DiagramError, parseDiagramModel } from "./diagramModel.js";

const schema = JSON.parse(readFileSync(new URL(import.meta.resolve("@tumaet/apollon/schema")), "utf8"));
const validate = new Ajv({ allErrors: false, strict: false }).compile(schema);
export const MAX_DIAGRAM_PNG_BYTES = 2 * 1024 * 1024;

export function isNativeDiagramSource(source: string): boolean {
  try {
    const value = JSON.parse(source);
    return Boolean(value && typeof value === "object" && "version" in value);
  } catch { return false; }
}

export function resourceDiagramModel(source: unknown) {
  const model = parseDiagramModel(source);
  if (!validate(model)) throw new DiagramError("Les données du diagramme ne respectent pas le format Apollon. Ouvrez-le dans l’éditeur pour les corriger.");
  return model;
}

/** Apollon's browser exporter supplies a PNG; no client SVG is evaluated on the server. */
export async function renderResourceDiagram(source: unknown, input: unknown): Promise<Buffer> {
  const model = resourceDiagramModel(source);
  if (!model.nodes.length) throw new DiagramError("Ajoutez au moins un élément pour afficher l’aperçu du diagramme.");
  if (typeof input !== "string" || !input.startsWith("data:image/png;base64,")) {
    throw new DiagramError("L’aperçu du diagramme est requis. Ouvrez le diagramme dans l’éditeur et réessayez.");
  }
  const base64 = input.slice("data:image/png;base64,".length);
  if (base64.length > Math.ceil(MAX_DIAGRAM_PNG_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new DiagramError("L’aperçu PNG du diagramme est invalide ou dépasse 2 Mo.");
  }
  const image = Buffer.from(base64, "base64");
  if (image.length > MAX_DIAGRAM_PNG_BYTES || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new DiagramError("L’aperçu doit être une image PNG valide de moins de 2 Mo.");
  }
  try {
    const metadata = await sharp(image, { limitInputPixels: 4096 * 4096 }).metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) !== 1) {
      throw new Error("dimensions");
    }
    const fitted = await sharp(image, { limitInputPixels: 4096 * 4096 })
      .resize({ width: 1344, height: 976, fit: "inside" }).ensureAlpha().png().toBuffer({ resolveWithObject: true });
    return await sharp({ create: { width: 1472, height: 1104, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: fitted.data, left: Math.floor((1472 - fitted.info.width) / 2), top: Math.floor((1104 - fitted.info.height) / 2) }]).png().toBuffer();
  } catch {
    throw new DiagramError("L’aperçu PNG est illisible ou trop grand. Actualisez-le dans l’éditeur avant d’enregistrer.");
  }
}
