import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WanTransitionStyle } from "./wanTransitions.js";

export type BatchItemStatus = "pending" | "voice" | "video" | "short" | "done" | "error" | "stopped";

export type BatchItem = {
  id: string;
  avatarId: string;
  avatarName: string;
  generationId?: string;
  name: string;
  text: string;
  status: BatchItemStatus;
  progress: number;
  message: string;
  error?: string;
};

export type BatchVideoSettings = {
  engine: "wan-s2v" | "hybrid" | "longcat";
  upscale: boolean;
  quality: "fast" | "normal" | "final";
  continuity: "stable" | "continuous";
  stabilizationSeconds: number;
  sourceMode: "strict" | "creative";
  framing: "original" | "fit" | "crop";
  motionPrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  transitionStyle?: WanTransitionStyle;
  short?: {
    enabled: boolean;
    framing: "blur" | "crop" | "fit";
    upscale: boolean;
    aiModel: "RealESRGAN_x2plus" | "RealESRGAN_x4plus";
    normalizeAudio: boolean;
  };
};

export type BatchRun = {
  id: string;
  name: string;
  status: "queued" | "running" | "stopping" | "stopped" | "done" | "error";
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  currentIndex: number;
  progress: number;
  message: string;
  items: BatchItem[];
  videoSettings: BatchVideoSettings;
};

export class BatchStore {
  private readonly runs = new Map<string, BatchRun>();
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(root, "batches.json");
  }

  async init(): Promise<void> {
    let stored: BatchRun[] = [];
    try {
      stored = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {}
    for (const run of Array.isArray(stored) ? stored : []) {
      if (!run?.id || !Array.isArray(run.items)) continue;
      if (run.status === "running" || run.status === "queued" || run.status === "stopping") {
        run.status = "stopped";
        run.finishedAt = Date.now();
        run.message = "Batch interrompu par un redemarrage du serveur. Il peut etre repris.";
        for (const item of run.items) {
          if (item.status === "voice" || item.status === "video" || item.status === "short") {
            item.status = "stopped";
            item.message = "Interrompu par le redemarrage.";
          }
        }
      }
      this.runs.set(run.id, run);
    }
    await this.flush();
  }

  list(): BatchRun[] {
    return [...this.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): BatchRun | undefined {
    return this.runs.get(id);
  }

  async create(input: Omit<BatchRun, "id" | "createdAt" | "updatedAt">): Promise<BatchRun> {
    const now = Date.now();
    const run: BatchRun = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.runs.set(run.id, run);
    await this.flush();
    return run;
  }

  async save(run: BatchRun): Promise<void> {
    run.updatedAt = Date.now();
    this.runs.set(run.id, run);
    await this.flush();
  }

  newItem(input: Pick<BatchItem, "avatarId" | "avatarName" | "name" | "text">): BatchItem {
    return {
      ...input,
      id: randomUUID(),
      status: "pending",
      progress: 0,
      message: "En attente"
    };
  }

  private async flush(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.list(), null, 2), "utf8");
    await fs.rename(temp, this.file);
  }
}
