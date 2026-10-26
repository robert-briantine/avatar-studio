import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { renderResourceLatex, resourceLatexColor } from "./latex.js";
import { renderResourceCode, resourceCodeTheme } from "./resourceCode.js";
import type { CodeTheme } from "./codeHighlight.js";
import { isNativeDiagramSource, renderResourceDiagram, resourceDiagramModel } from "./resourceDiagram.js";
import { composeResourceVisual, CompositionError, resourceComposition, type ResourceComposition } from "./resourceComposition.js";

export const resourceTypes = [
  { id: "image", label: "Image générée" },
  { id: "latex", label: "Expression LaTeX" },
  { id: "typescript", label: "Code TypeScript" },
  { id: "diagram", label: "Diagramme" }
] as const;

export type ResourceType = typeof resourceTypes[number]["id"];
export type ResourceImageGeneration = {
  id: string;
  status: "running" | "done" | "error" | "interrupted";
  createdAt: number;
  finishedAt?: number;
  message: string;
  error?: string;
  reused?: boolean;
};
export type Resource = {
  id: string;
  name: string;
  type: ResourceType;
  source: string;
  codeTheme?: CodeTheme;
  latexColor?: string;
  backgroundImageId?: string;
  composition?: ResourceComposition;
  /** Optional rendered PNG, produced by the resource's renderer. */
  preview?: string;
  /** Original visual, retained so changing a background never composites an already composed image. */
  foreground?: string;
  /** Version of the referenced generated image used by the saved composition. */
  backgroundPreview?: string;
  imageGeneration?: ResourceImageGeneration;
  createdAt: number;
  updatedAt: number;
};

export class ResourceError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 = 400) { super(message); }
}

const validId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const nameKey = (name: string) => name.normalize("NFC").toLocaleLowerCase("fr");

function previewName(value: unknown, id: string | undefined): string {
  if (!id || typeof value !== "string") throw new Error("Aperçu de ressource invalide.");
  const version = value.startsWith(`${id}-`) ? value.slice(id.length + 1, -4) : "";
  if (value !== `${id}.png` && !(value.endsWith(".png") && validId(version))) throw new Error("Aperçu de ressource invalide.");
  return value;
}

function resourceName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ResourceError("Le nom de la ressource est obligatoire.");
  const name = value.trim().normalize("NFC");
  if (name.length > 120) throw new ResourceError("Le nom de la ressource est limité à 120 caractères.");
  if (/[{}\u0000-\u001f\u007f]/.test(name)) throw new ResourceError("Le nom ne doit contenir ni accolades ni caractères de contrôle.");
  return name;
}

function resourceType(value: unknown): ResourceType {
  if (!resourceTypes.some(type => type.id === value)) throw new ResourceError("Choisissez un type de ressource valide.");
  return value as ResourceType;
}

function resourceSource(value: unknown): string {
  if (typeof value !== "string") throw new ResourceError("Le contenu source doit être du texte.");
  if (Buffer.byteLength(value, "utf8") > 1024 * 1024) throw new ResourceError("Le contenu source est limité à 1 Mo.");
  return value;
}

function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ResourceError("Ressource invalide.");
  return input as Record<string, unknown>;
}

/** One library for all avatars, committed atomically outside the application code. */
export class ResourceStore {
  private resources = new Map<string, Resource>();
  private commits: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.root, "previews"), { recursive: true });
    let data: { version: number; resources: Resource[] };
    try {
      data = JSON.parse(await fs.readFile(path.join(this.root, "index.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Bibliothèque de ressources illisible : ${error instanceof Error ? error.message : String(error)}`);
    }
    if (data?.version !== 1 || !Array.isArray(data.resources)) throw new Error("Format de bibliothèque de ressources invalide.");
    const loaded = new Map<string, Resource>();
    const names = new Set<string>();
    let interrupted = false;
    for (const item of data.resources) {
      if (!item || !validId(item.id) || loaded.has(item.id)
        || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)
        || typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt)) {
        throw new Error("Entrée de bibliothèque de ressources invalide.");
      }
      const resource: Resource = {
        id: item.id, name: resourceName(item.name), type: resourceType(item.type), source: resourceSource(item.source),
        createdAt: item.createdAt, updatedAt: item.updatedAt
      };
      if (resource.type === "typescript") resource.codeTheme = resourceCodeTheme(item.codeTheme);
      if (resource.type === "latex") resource.latexColor = resourceLatexColor(item.latexColor);
      if (resource.type !== "image") resource.composition = resourceComposition(item.composition);
      if (item.backgroundImageId !== undefined) {
        if (!validId(item.backgroundImageId)) throw new Error("Référence d’image de fond invalide.");
        resource.backgroundImageId = item.backgroundImageId;
      }
      if (item.preview !== undefined) resource.preview = previewName(item.preview, resource.id);
      if (item.foreground !== undefined) resource.foreground = previewName(item.foreground, resource.id);
      if (item.backgroundPreview !== undefined) resource.backgroundPreview = previewName(item.backgroundPreview, resource.backgroundImageId);
      if (item.imageGeneration !== undefined) {
        const job = item.imageGeneration;
        if (resource.type !== "image" || !validId(job?.id) || !["running", "done", "error", "interrupted"].includes(job.status)
          || typeof job.createdAt !== "number" || !Number.isFinite(job.createdAt) || typeof job.message !== "string"
          || (job.finishedAt !== undefined && (typeof job.finishedAt !== "number" || !Number.isFinite(job.finishedAt)))
          || (job.error !== undefined && typeof job.error !== "string") || (job.reused !== undefined && typeof job.reused !== "boolean")) {
          throw new Error("État de génération d’image invalide.");
        }
        resource.imageGeneration = { ...job };
        if (job.status === "running") {
          interrupted = true;
          resource.imageGeneration = { ...job, status: "interrupted", finishedAt: Date.now(), message: "Génération interrompue par le redémarrage. Vous pouvez la relancer." };
        }
      }
      const key = nameKey(resource.name);
      if (names.has(key)) throw new Error(`Nom de ressource dupliqué : ${resource.name}`);
      names.add(key);
      loaded.set(resource.id, resource);
    }
    for (const resource of loaded.values()) this.checkBackground(resource, loaded);
    if (interrupted) await this.writeIndex(loaded);
    this.resources = loaded;
  }

  list(): Resource[] {
    return structuredClone([...this.resources.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, "fr")));
  }

  get(id: string): Resource | undefined {
    const resource = this.resources.get(id);
    return resource ? structuredClone(resource) : undefined;
  }

  findByName(name: string): Resource | undefined {
    const key = nameKey(name.trim());
    const resource = [...this.resources.values()].find(item => nameKey(item.name) === key);
    return resource ? structuredClone(resource) : undefined;
  }

  previewPath(id: string): string | undefined {
    const resource = this.resources.get(id);
    return resource?.preview ? path.join(this.root, "previews", resource.preview) : undefined;
  }

  /** Validate the dependency before serving a composition; refresh it after the named image changes. */
  async resolvePreview(id: string): Promise<string | undefined> {
    const resource = this.resources.get(id);
    if (resource?.backgroundImageId) {
      const background = await this.backgroundImage(resource.backgroundImageId, this.resources);
      if (resource.preview && resource.backgroundPreview !== background.preview) {
        if (resource.type === "diagram" && !isNativeDiagramSource(resource.source)) {
          throw new CompositionError("Convertissez cette ancienne description en diagramme pour préparer sa composition.");
        }
        await this.update(id, {});
      }
    }
    return this.previewPath(id);
  }

  async composePreview(type: Exclude<ResourceType, "image">, input: unknown, foreground: Buffer): Promise<Buffer> {
    const body = inputObject(input);
    const settings = resourceComposition(body.composition);
    const id = this.backgroundId(body.backgroundImageId);
    if (!id) return foreground;
    const background = await this.backgroundImage(id, this.resources);
    return composeResourceVisual({ type, source: resourceSource(body.source),
      codeTheme: type === "typescript" ? resourceCodeTheme(body.codeTheme) : undefined, composition: settings }, foreground, background.data);
  }

  async create(input: unknown): Promise<Resource> {
    const body = inputObject(input);
    const name = resourceName(body.name);
    const type = resourceType(body.type);
    const source = resourceSource(body.source === undefined ? "" : body.source);
    const backgroundImageId = this.backgroundId(body.backgroundImageId);
    const codeTheme = type === "typescript" ? resourceCodeTheme(body.codeTheme) : undefined;
    const latexColor = type === "latex" ? resourceLatexColor(body.latexColor) : undefined;
    const composition = type !== "image" ? resourceComposition(body.composition) : undefined;
    return this.commit(resources => {
      this.checkName(name, resources);
      const now = Date.now();
      const resource: Resource = { id: randomUUID(), name, type, source, createdAt: now, updatedAt: now };
      if (codeTheme) resource.codeTheme = codeTheme;
      if (latexColor) resource.latexColor = latexColor;
      if (composition) resource.composition = composition;
      if (backgroundImageId) resource.backgroundImageId = backgroundImageId;
      this.checkBackground(resource, resources);
      resources.set(resource.id, resource);
      return resource;
    }, true, body.diagramPreview);
  }

  async update(id: string, input: unknown): Promise<Resource> {
    const body = inputObject(input);
    return this.commit(resources => {
      const previous = resources.get(id);
      if (!previous) throw new ResourceError("Ressource introuvable.", 404);
      if (previous.imageGeneration?.status === "running") throw new ResourceError("Une génération est en cours pour cette ressource. Attendez sa fin ou arrêtez-la avant de la modifier.", 409);
      if (body.type !== undefined && resourceType(body.type) !== previous.type) {
        throw new ResourceError("Le type d’une ressource existante ne peut pas être changé. Créez une nouvelle ressource pour choisir un autre type.");
      }
      const resource: Resource = {
        ...previous,
        name: body.name === undefined ? previous.name : resourceName(body.name),
        source: body.source === undefined ? previous.source : resourceSource(body.source),
        updatedAt: Date.now()
      };
      if (resource.type === "typescript") resource.codeTheme = resourceCodeTheme(body.codeTheme === undefined ? previous.codeTheme : body.codeTheme);
      if (resource.type === "latex") resource.latexColor = resourceLatexColor(body.latexColor === undefined ? previous.latexColor : body.latexColor);
      if (resource.type !== "image") resource.composition = resourceComposition(body.composition === undefined ? previous.composition : body.composition);
      if ("backgroundImageId" in body) {
        const background = this.backgroundId(body.backgroundImageId);
        if (background) resource.backgroundImageId = background;
        else delete resource.backgroundImageId;
      }
      this.checkName(resource.name, resources, id);
      this.checkBackground(resource, resources);
      if (resource.source !== previous.source || resource.codeTheme !== previous.codeTheme || resource.latexColor !== previous.latexColor) {
        delete resource.foreground;
        delete resource.preview;
        delete resource.backgroundPreview;
        delete resource.imageGeneration;
      }
      if (resource.backgroundImageId !== previous.backgroundImageId
        || Boolean(resource.backgroundImageId) && JSON.stringify(resource.composition) !== JSON.stringify(previous.composition)) {
        delete resource.preview;
        delete resource.backgroundPreview;
        delete resource.imageGeneration;
      }
      resources.set(id, resource);
      return resource;
    }, true, body.diagramPreview);
  }

  async beginImageGeneration(id: string): Promise<Resource> {
    return this.commit(resources => {
      const previous = resources.get(id);
      if (!previous) throw new ResourceError("Ressource introuvable.", 404);
      if (previous.type !== "image") throw new ResourceError("Seules les ressources de type Image générée peuvent générer une image.");
      if (!previous.source.trim()) throw new ResourceError("Décrivez l’image à générer.");
      if (previous.imageGeneration?.status === "running") throw new ResourceError("Une génération est déjà en cours pour cette ressource.", 409);
      const now = Date.now();
      const resource: Resource = { ...previous, updatedAt: now,
        imageGeneration: { id: randomUUID(), status: "running", createdAt: now, message: "Préparation de l’image…" } };
      resources.set(id, resource);
      return resource;
    });
  }

  async finishImageGeneration(id: string, jobId: string, image?: Buffer, signal?: AbortSignal): Promise<Resource> {
    if (!validId(id) || !validId(jobId)) throw new ResourceError("Identifiant de génération invalide.");
    const filename = `${id}-${randomUUID()}.png`;
    const target = path.join(this.root, "previews", filename);
    const temporary = path.join(this.root, "previews", `.${randomUUID()}.png`);
    let published = false;
    try {
      if (image) {
        const png = await sharp(image).rotate().png({ compressionLevel: 6 }).toBuffer();
        signal?.throwIfAborted();
        await fs.writeFile(temporary, png);
        await fs.rename(temporary, target);
      }
      const result = await this.commit(resources => {
        signal?.throwIfAborted();
        const previous = this.runningImageGeneration(resources, id, jobId);
        if (!image && !previous.preview) throw new ResourceError("Aucune image enregistrée à réutiliser.");
        const now = Date.now();
        const resource: Resource = { ...previous, preview: image ? filename : previous.preview, updatedAt: now,
          imageGeneration: { ...previous.imageGeneration!, status: "done", finishedAt: now, reused: !image,
            message: image ? "Image générée et enregistrée." : "Image enregistrée réutilisée." } };
        resources.set(id, resource);
        return resource;
      });
      published = true;
      return result;
    } finally {
      await fs.rm(temporary, { force: true });
      if (image && !published) await fs.rm(target, { force: true });
    }
  }

  async failImageGeneration(id: string, jobId: string, error: unknown, interrupted = false): Promise<Resource> {
    return this.commit(resources => {
      const previous = this.runningImageGeneration(resources, id, jobId);
      const now = Date.now();
      const resource: Resource = { ...previous, updatedAt: now,
        imageGeneration: { ...previous.imageGeneration!, status: interrupted ? "interrupted" : "error", finishedAt: now,
          message: interrupted ? "Génération de l’image arrêtée." : "Échec de la génération de l’image.",
          error: error instanceof Error ? error.message : String(error) } };
      resources.set(id, resource);
      return resource;
    });
  }

  private runningImageGeneration(resources: Map<string, Resource>, id: string, jobId: string): Resource {
    const resource = resources.get(id);
    if (!resource) throw new ResourceError("Ressource introuvable.", 404);
    if (resource.imageGeneration?.id !== jobId || resource.imageGeneration.status !== "running") {
      throw new ResourceError("Cette génération d’image n’est plus active.", 409);
    }
    return resource;
  }

  private backgroundId(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (!validId(value)) throw new ResourceError("Choisissez une image de fond valide.");
    return value;
  }

  private checkName(name: string, resources: Map<string, Resource>, exceptId?: string): void {
    if ([...resources.values()].some(item => item.id !== exceptId && nameKey(item.name) === nameKey(name))) {
      throw new ResourceError("Une ressource porte déjà ce nom. Choisissez un nom unique.", 409);
    }
  }

  private checkBackground(resource: Resource, resources: Map<string, Resource>): void {
    if (!resource.backgroundImageId) return;
    if (resource.type === "image") throw new ResourceError("Une image générée ne peut pas référencer une autre image de fond.");
    if (resources.get(resource.backgroundImageId)?.type !== "image") throw new ResourceError("L’image de fond référencée est introuvable ou n’est pas une image générée.");
  }

  private async backgroundImage(id: string, resources: Map<string, Resource>): Promise<{ preview: string; data: Buffer }> {
    const background = resources.get(id);
    if (!background || background.type !== "image") throw new CompositionError("L’image de fond référencée est introuvable.");
    if (!background.preview) throw new CompositionError(`L’image de fond « ${background.name} » n’est pas disponible. Générez-la avant de préparer la composition.`);
    try {
      const data = await fs.readFile(path.join(this.root, "previews", background.preview));
      await sharp(data, { limitInputPixels: 40_000_000 }).stats();
      return { preview: background.preview, data };
    } catch { throw new CompositionError(`L’image de fond « ${background.name} » est absente ou illisible. Générez-la de nouveau.`); }
  }

  private commit(change: (resources: Map<string, Resource>) => Resource, withSourcePreview = false, diagramPreview?: unknown): Promise<Resource> {
    const operation = this.commits.then(async () => {
      const next = new Map(this.resources);
      let resource = change(next);
      const created: string[] = [];
      let published = false;
      const publish = async (image: Buffer): Promise<string> => {
        const filename = `${resource.id}-${randomUUID()}.png`;
        const target = path.join(this.root, "previews", filename);
        const temporary = path.join(this.root, "previews", `.${randomUUID()}.png`);
        try {
          await fs.writeFile(temporary, image); await fs.rename(temporary, target); created.push(target);
          return filename;
        } finally { await fs.rm(temporary, { force: true }); }
      };
      try {
        let image: Buffer | undefined;
        let foreground = resource.foreground;
        if (withSourcePreview && ["latex", "typescript"].includes(resource.type) && resource.source.trim()) {
          image = resource.type === "latex" ? await renderResourceLatex(resource.source, resource.latexColor) : await renderResourceCode(resource.source, resource.codeTheme);
        } else if (withSourcePreview && resource.type === "diagram") {
          // Older text-only diagrams remain readable until explicitly converted in the UI.
          if (isNativeDiagramSource(resource.source)) {
            const model = resourceDiagramModel(resource.source);
            if (!model.nodes.length) {
              delete resource.preview;
              delete resource.foreground;
              delete resource.backgroundPreview;
            } else {
              const background = resource.backgroundImageId ? await this.backgroundImage(resource.backgroundImageId, next) : undefined;
              if (diagramPreview !== undefined) image = await renderResourceDiagram(resource.source, diagramPreview);
              else if (!resource.preview || background && resource.backgroundPreview !== background.preview) {
                const previous = this.resources.get(resource.id);
                foreground ??= previous?.source === resource.source ? previous.foreground || previous.preview : undefined;
                if (foreground) {
                  try { image = await fs.readFile(path.join(this.root, "previews", foreground)); await sharp(image).stats(); }
                  catch { throw new CompositionError("Le visuel du diagramme est indisponible. Ouvrez-le dans l’éditeur puis enregistrez-le de nouveau."); }
                } else image = await renderResourceDiagram(resource.source, diagramPreview);
              }
            }
          } else if (diagramPreview !== undefined || resource.source.trim() && isNativeDiagramSource(this.resources.get(resource.id)?.source ?? "")) {
            image = await renderResourceDiagram(resource.source, diagramPreview);
          }
        }
        if (image) {
          const background = resource.backgroundImageId ? await this.backgroundImage(resource.backgroundImageId, next) : undefined;
          const visual = background ? await composeResourceVisual({ ...resource, type: resource.type as "latex" | "typescript" | "diagram" }, image, background.data) : image;
          // Reusing a diagram's original PNG is safe when only its background or layout changes.
          const reusable = resource.type === "diagram" && diagramPreview === undefined ? foreground : undefined;
          const original = reusable || await publish(image);
          resource = { ...resource, foreground: original, preview: background ? await publish(visual) : original };
          if (background) resource.backgroundPreview = background.preview;
          else delete resource.backgroundPreview;
        }
        next.set(resource.id, resource);
        await this.writeIndex(next);
        this.resources = next;
        published = true;
        return structuredClone(resource);
      } finally {
        if (!published) for (const file of created) await fs.rm(file, { force: true });
      }
    });
    this.commits = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async writeIndex(resources: Map<string, Resource>): Promise<void> {
    const temporary = path.join(this.root, `.${randomUUID()}.json`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, resources: [...resources.values()] }, null, 2), "utf8");
      await fs.rename(temporary, path.join(this.root, "index.json"));
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
