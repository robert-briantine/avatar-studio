import fs from "node:fs/promises";
import sharp from "sharp";
import { ResourceError, ResourceStore, type Resource } from "./resourceStore.js";

/** Each named image owns its output and its cancellation controller. */
export class ResourceImages {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly store: ResourceStore, private readonly generate: (description: string, signal: AbortSignal) => Promise<Buffer>) {}

  async start(id: string): Promise<Resource> {
    const resource = await this.store.beginImageGeneration(id);
    const controller = new AbortController();
    this.active.set(id, controller);
    void this.run(resource, controller.signal)
      .catch(error => console.error("[resource image]", error))
      .finally(() => { if (this.active.get(id) === controller) this.active.delete(id); });
    return resource;
  }

  stop(id: string): void {
    const controller = this.active.get(id);
    if (!controller) throw new ResourceError("Aucune génération d’image en cours pour cette ressource.", 409);
    controller.abort();
  }

  private async run(resource: Resource, signal: AbortSignal): Promise<void> {
    const jobId = resource.imageGeneration!.id;
    try {
      const existing = this.store.previewPath(resource.id);
      let reusable = false;
      if (existing) {
        try { await sharp(await fs.readFile(existing)).stats(); reusable = true; }
        catch { /* Missing or damaged outputs can be generated again. */ }
      }
      signal.throwIfAborted();
      if (reusable) await this.store.finishImageGeneration(resource.id, jobId, undefined, signal);
      else {
        const image = await this.generate(resource.source, signal);
        signal.throwIfAborted();
        await this.store.finishImageGeneration(resource.id, jobId, image, signal);
      }
    } catch (error) {
      await this.store.failImageGeneration(resource.id, jobId, error, signal.aborted);
    }
  }
}
