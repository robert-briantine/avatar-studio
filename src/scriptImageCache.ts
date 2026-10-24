import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

type ImageEntry = { content: string; filename: string; createdAt: number };
export type CachedScriptImage = ImageEntry & { path: string };

/** Persistent exact-content cache shared by the application's avatar projects. */
export class ScriptImageCache {
  private readonly entries = new Map<string, ImageEntry>();
  private readonly pending = new Map<string, Promise<CachedScriptImage>>();
  private commits = Promise.resolve();

  constructor(private readonly root: string) {}

  private filename(content: string): string {
    return `${createHash("sha256").update(content).digest("hex")}.png`;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    let data: { version: number; images: ImageEntry[] };
    try {
      data = JSON.parse(await fs.readFile(path.join(this.root, "index.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Dictionnaire des images illisible : ${error instanceof Error ? error.message : String(error)}`);
    }
    if (data?.version !== 1 || !Array.isArray(data.images)) throw new Error("Format du dictionnaire des images invalide.");
    for (const entry of data.images) {
      if (typeof entry?.content !== "string" || !entry.content.trim() || entry.filename !== this.filename(entry.content)) {
        throw new Error("Entrée du dictionnaire des images invalide.");
      }
      this.entries.set(entry.content, entry);
    }
  }

  async get(content: string, generate: () => Promise<Buffer>, signal?: AbortSignal): Promise<CachedScriptImage> {
    signal?.throwIfAborted();
    if (!content.trim()) throw new Error("La description de l’image est vide.");
    let promise = this.pending.get(content);
    if (!promise) {
      promise = this.loadOrGenerate(content, generate, signal);
      this.pending.set(content, promise);
      void promise.finally(() => this.pending.delete(content)).catch(() => undefined);
    }
    // Cancelling a waiting request does not cancel another request's generation.
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      promise!.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private async loadOrGenerate(content: string, generate: () => Promise<Buffer>, signal?: AbortSignal): Promise<CachedScriptImage> {
    const existing = this.entries.get(content);
    if (existing) {
      const imagePath = path.join(this.root, existing.filename);
      try {
        await sharp(imagePath).stats();
        signal?.throwIfAborted();
        return { ...existing, path: imagePath };
      } catch (error) {
        if (signal?.aborted) throw error;
        // Missing or damaged pixels are regenerated from the original key.
      }
    }
    const generated = await generate();
    signal?.throwIfAborted();
    const png = await sharp(generated).rotate().png().toBuffer();
    const entry: ImageEntry = { content, filename: this.filename(content), createdAt: Date.now() };
    const imagePath = path.join(this.root, entry.filename);
    const temporary = path.join(this.root, `.${randomUUID()}.png`);
    try {
      await fs.writeFile(temporary, png);
      signal?.throwIfAborted();
      await fs.rename(temporary, imagePath);
      const commit = this.commits.then(async () => {
        const previous = this.entries.get(content);
        const indexTemp = path.join(this.root, `.${randomUUID()}.json`);
        this.entries.set(content, entry);
        try {
          await fs.writeFile(indexTemp, JSON.stringify({ version: 1, images: [...this.entries.values()] }, null, 2), "utf8");
          await fs.rename(indexTemp, path.join(this.root, "index.json"));
        } catch (error) {
          if (previous) this.entries.set(content, previous);
          else this.entries.delete(content);
          throw error;
        } finally {
          await fs.rm(indexTemp, { force: true });
        }
      });
      this.commits = commit.catch(() => undefined);
      await commit;
      return { ...entry, path: imagePath };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
