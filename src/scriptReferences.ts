import sharp from "sharp";
import type { AvatarScript } from "./avatarScript.js";
import type { ResourceStore, ResourceType } from "./resourceStore.js";
import { isNativeDiagramSource, resourceDiagramModel } from "./resourceDiagram.js";

/** Bind the spelling in a saved scenario to a stable library resource ID. */
export type ScriptResourceBinding = { name: string; resourceId: string };
export type ScriptReference = { resourceId: string; name: string; type: ResourceType; path: string };

/** Resolve and decode every named visual before TTS, generated images or Wan can run. */
export async function resolveScriptReferences(
  script: AvatarScript | undefined, store: ResourceStore, bindings?: ScriptResourceBinding[], signal?: AbortSignal
): Promise<Map<string, ScriptReference>> {
  const references = new Map<string, ScriptReference>();
  const names = new Set(script?.sequences.flatMap(sequence => sequence.mode === "ref" ? [sequence.content] : []) ?? []);
  if (!names.size) return references;
  const bound = new Map<string, string>();
  if (bindings !== undefined) {
    const invalid = () => new RangeError("Les références enregistrées avec la voix sont invalides. Régénère la voix pour rétablir leurs associations.");
    if (!Array.isArray(bindings)) throw invalid();
    for (const binding of bindings) {
      if (!binding || typeof binding.name !== "string" || !names.has(binding.name) || bound.has(binding.name)
        || typeof binding.resourceId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(binding.resourceId)) throw invalid();
      bound.set(binding.name, binding.resourceId);
    }
    if (bound.size !== names.size) throw invalid();
  }
  const validated = new Map<string, ScriptReference>();
  for (const name of names) {
    signal?.throwIfAborted();
    const resource = bindings === undefined ? store.findByName(name) : store.get(bound.get(name)!);
    if (!resource) throw new RangeError(`Ressource « ${name} » introuvable. Vérifiez son nom dans la bibliothèque.`);
    const existing = validated.get(resource.id);
    if (existing) { references.set(name, existing); continue; }
    try {
      if (resource.type !== "image" && !resource.source.trim()) throw new Error("La ressource est encore un brouillon vide. Enregistrez son contenu dans la bibliothèque.");
      if (resource.type === "diagram" && (!isNativeDiagramSource(resource.source) || !resourceDiagramModel(resource.source).nodes.length)) {
        throw new Error("Le diagramme n’a pas encore de visuel. Créez-le ou convertissez son ancien texte dans Apollon, puis enregistrez-le.");
      }
      const file = await store.resolvePreview(resource.id);
      if (!file) throw new Error("Aucun visuel enregistré. Générez l’image ou enregistrez la ressource dans son éditeur.");
      await sharp(file, { limitInputPixels: 40_000_000 }).stats();
      signal?.throwIfAborted();
      const reference = { resourceId: resource.id, name: resource.name, type: resource.type, path: file };
      validated.set(resource.id, reference); references.set(name, reference);
    } catch (error) {
      if (signal?.aborted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const message = /Input file|unsupported image|corrupt|pngload|Vips|ENOENT/i.test(detail)
        ? "Le visuel enregistré est absent ou illisible. Enregistrez ou générez de nouveau cette ressource."
        : detail;
      throw new RangeError(`Ressource « ${name} » indisponible : ${message}`);
    }
  }
  return references;
}

export function bindScriptReferences(references: Map<string, ScriptReference>): ScriptResourceBinding[] | undefined {
  return references.size ? [...references].map(([name, reference]) => ({ name, resourceId: reference.resourceId })) : undefined;
}

/** Transparent formulas and diagrams need a light canvas; snapshot pixels before GPU work. */
export async function prepareScriptReferenceImage(input: string, output: string, width: number, height: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await sharp(input, { limitInputPixels: 40_000_000 }).rotate().flatten({ background: "white" })
    .resize({ width, height, fit: "contain", background: "white" }).png().toFile(output);
  signal?.throwIfAborted();
}
