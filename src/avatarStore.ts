import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Asset = { name: string; path: string; url: string; duration?: number };

export type ProjectJob = {
  id: string;
  type: "image" | "voice-fingerprint" | "voice" | "video-preview" | "video-wan";
  status: "queued" | "running" | "done" | "error" | "interrupted";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: number;
  current?: number;
  total?: number;
  doneSeconds?: number;
  totalSeconds?: number;
  etaSeconds?: number;
  message: string;
  error?: string;
  generationId?: string;
  batchId?: string;
};

export type VoiceAsset = Asset & {
  text: string;
  presetId: string;
  voicePrompt: string;
  seed?: number;
};

export type VideoAsset = Asset & {
  engine: "preview" | "wan-s2v";
  continuity?: "stable" | "continuous";
  stabilizationSeconds?: number;
};

export type VoiceFingerprint = Asset & {
  refText: string;
  presetId: string;
  voicePrompt: string;
  seed?: number;
  createdAt: number;
};

export type AvatarGeneration = {
  id: string;
  name: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  status: "draft" | "voice-running" | "voice-ready" | "video-running" | "done" | "error" | "stopped";
  voice?: VoiceAsset;
  video?: VideoAsset;
  error?: string;
  batchId?: string;
  videoSettings?: {
    quality?: "fast" | "normal" | "final";
    continuity: "stable" | "continuous";
    stabilizationSeconds: number;
    sourceMode?: "strict" | "creative";
    framing?: "original" | "fit" | "crop";
    motionPrompt?: string;
    width?: number;
    height?: number;
    steps?: number;
    cfg?: number;
    seed?: number;
  };
};

export type AvatarProject = {
  id: string;
  name: string;
  folderName: string;
  createdAt: number;
  updatedAt: number;
  avatar?: Asset & {
    source: "generated" | "uploaded";
    prompt?: string;
    builtPrompt?: string;
    seed?: number;
    builder?: Record<string, unknown>;
    generation?: { quality?: string; steps?: number; width?: number; height?: number; strictReset?: boolean };
  };
  voiceFingerprint?: VoiceFingerprint;
  generations?: AvatarGeneration[];
  // Alias de compatibilite vers la derniere generation. Les nouveaux ecrans
  // utilisent generations[] et ne remplacent plus l'historique.
  voice?: VoiceAsset;
  video?: VideoAsset;
  videoSettings?: { continuity: "stable" | "continuous"; stabilizationSeconds: number };
  currentJob?: ProjectJob;
  jobHistory?: ProjectJob[];
};

type StoredProject = Omit<AvatarProject, "avatar" | "voice" | "video"> & {
  avatar?: Omit<NonNullable<AvatarProject["avatar"]>, "path"> & { path: string };
  voice?: Omit<NonNullable<AvatarProject["voice"]>, "path"> & { path: string };
  video?: Omit<NonNullable<AvatarProject["video"]>, "path"> & { path: string };
  voiceFingerprint?: Omit<VoiceFingerprint, "path"> & { path: string };
  generations?: Array<Omit<AvatarGeneration, "voice" | "video"> & {
    voice?: Omit<VoiceAsset, "path"> & { path: string };
    video?: Omit<VideoAsset, "path"> & { path: string };
  }>;
};

function safeFolderPart(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, 80);
  return normalized || "projet";
}

function makeFolderName(name: string, id: string): string {
  return `${safeFolderPart(name)}--${id.slice(0, 8)}`;
}

function assetUrl(projectId: string, folder: "avatar" | "voice" | "video", filename: string): string {
  return `/project-files/${encodeURIComponent(projectId)}/${folder}/${encodeURIComponent(filename)}`;
}

export class AvatarStore {
  private readonly map = new Map<string, AvatarProject>();
  private readonly baseById = new Map<string, string>();
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let base = path.join(this.root, entry.name);
      const file = path.join(base, "project.json");
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as StoredProject;
        if (!raw?.id) continue;
        const name = typeof (raw as any).name === "string" && (raw as any).name.trim()
          ? (raw as any).name.trim()
          : `Projet ${raw.id.slice(0, 8)}`;
        const desiredFolder = makeFolderName(name, raw.id);

        // Migration automatique des anciens dossiers UUID vers un dossier lisible.
        if (entry.name !== desiredFolder) {
          const desiredBase = path.join(this.root, desiredFolder);
          try {
            await fs.access(desiredBase);
          } catch {
            await fs.rename(base, desiredBase);
            base = desiredBase;
          }
        }

        const abs = (asset: any, folder: "avatar" | "voice" | "video") => asset ? {
          ...asset,
          path: path.resolve(base, asset.path),
          url: assetUrl(raw.id, folder, asset.name)
        } : undefined;

        const project: AvatarProject = {
          ...raw,
          name,
          folderName: path.basename(base),
          avatar: abs(raw.avatar, "avatar"),
          voice: abs(raw.voice, "voice"),
          video: abs(raw.video, "video"),
          voiceFingerprint: abs(raw.voiceFingerprint, "voice"),
          generations: (raw.generations || []).map(generation => ({
            ...generation,
            voice: abs(generation.voice, "voice"),
            video: abs(generation.video, "video")
          }))
        };

        // Les versions anterieures ne conservaient qu'une voix et une video.
        // La voix existante est une excellente reference de clonage : elle
        // devient donc l'empreinte initiale et le rendu reste dans l'historique.
        if (!project.voiceFingerprint && project.voice) {
          project.voiceFingerprint = {
            ...project.voice,
            refText: project.voice.text || "",
            createdAt: project.createdAt
          };
        }
        if (!(project.generations || []).length && (project.voice || project.video)) {
          project.generations = [{
            id: randomUUID(),
            name: "Generation importee",
            text: project.voice?.text || "",
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            status: project.video ? "done" : project.voice ? "voice-ready" : "draft",
            voice: project.voice,
            video: project.video
          }];
        }

        if (project.currentJob && (project.currentJob.status === "queued" || project.currentJob.status === "running")) {
          project.currentJob = {
            ...project.currentJob,
            status: "interrupted",
            finishedAt: Date.now(),
            message: "Génération interrompue par un redémarrage du serveur.",
            error: "Le processus serveur a été redémarré avant la fin du job."
          };
        }

        this.map.set(project.id, project);
        this.baseById.set(project.id, base);
        await this.save(project);
      } catch {
        // Un dossier incomplet ne bloque pas les autres projets.
      }
    }
  }

  async create(name: string): Promise<AvatarProject> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Le nom du projet est obligatoire.");
    const now = Date.now();
    const id = randomUUID();
    const folderName = makeFolderName(cleanName.slice(0, 120), id);
    const p: AvatarProject = {
      id,
      name: cleanName.slice(0, 120),
      folderName,
      createdAt: now,
      updatedAt: now
    };
    this.map.set(p.id, p);
    this.baseById.set(p.id, path.join(this.root, folderName));
    await this.ensure(p);
    await this.save(p);
    return p;
  }

  get(id: string): AvatarProject | undefined { return this.map.get(id); }

  list(): AvatarProject[] {
    return [...this.map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async removeGeneration(p: AvatarProject, generationId: string): Promise<AvatarGeneration> {
    const generations = p.generations || [];
    const index = generations.findIndex(generation => generation.id === generationId);
    if (index < 0) throw new Error("Generation inconnue pour cet avatar.");
    const [removed] = generations.splice(index, 1);
    p.generations = generations;

    // Les alias historiques pointent vers le dernier rendu disponible. Ils ne
    // doivent jamais conserver une reference vers une generation supprimee.
    p.voice = generations.find(generation => generation.voice)?.voice;
    p.video = generations.find(generation => generation.video)?.video;

    const referenced = new Set<string>();
    const keep = (asset?: Asset) => { if (asset) referenced.add(path.resolve(asset.path)); };
    keep(p.avatar);
    keep(p.voiceFingerprint);
    keep(p.voice);
    keep(p.video);
    for (const generation of generations) {
      keep(generation.voice);
      keep(generation.video);
    }

    for (const asset of [removed.voice, removed.video]) {
      if (asset && !referenced.has(path.resolve(asset.path))) {
        await fs.rm(asset.path, { force: true }).catch(() => undefined);
      }
    }
    await this.save(p);
    return removed;
  }

  async archive(p: AvatarProject): Promise<string> {
    const base = this.base(p);
    const trashRoot = path.join(path.dirname(this.root), "trash", "avatars");
    await fs.mkdir(trashRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(trashRoot, `${path.basename(base)}--deleted-${stamp}-${randomUUID().slice(0, 8)}`);
    await fs.rename(base, target);
    this.map.delete(p.id);
    this.baseById.delete(p.id);
    return target;
  }

  async rename(p: AvatarProject, newName: string): Promise<void> {
    const cleanName = newName.trim();
    if (!cleanName) throw new Error("Le nom du projet est obligatoire.");
    const oldBase = this.base(p);
    const newFolderName = makeFolderName(cleanName.slice(0, 120), p.id);
    const newBase = path.join(this.root, newFolderName);

    if (path.resolve(oldBase) !== path.resolve(newBase)) {
      await fs.rename(oldBase, newBase);
      const remap = (asset?: Asset) => {
        if (!asset) return;
        const rel = path.relative(oldBase, asset.path);
        asset.path = path.join(newBase, rel);
      };
      remap(p.avatar);
      remap(p.voice);
      remap(p.video);
      remap(p.voiceFingerprint);
      for (const generation of p.generations || []) {
        remap(generation.voice);
        remap(generation.video);
      }
      this.baseById.set(p.id, newBase);
    }

    p.name = cleanName.slice(0, 120);
    p.folderName = newFolderName;
    await this.save(p);
  }

  async ensure(p: AvatarProject): Promise<string> {
    const base = this.base(p);
    await Promise.all(["avatar", "voice", "video"].map(x => fs.mkdir(path.join(base, x), { recursive: true })));
    return base;
  }

  async save(p: AvatarProject): Promise<void> {
    p.updatedAt = Date.now();
    const base = await this.ensure(p);
    p.folderName = path.basename(base);
    const normalize = (asset: any, folder: "avatar" | "voice" | "video") => asset ? {
      ...asset,
      url: assetUrl(p.id, folder, asset.name),
      path: path.relative(base, asset.path)
    } : undefined;
    const serial: StoredProject = {
      ...p,
      avatar: normalize(p.avatar, "avatar"),
      voice: normalize(p.voice, "voice"),
      video: normalize(p.video, "video"),
      voiceFingerprint: normalize(p.voiceFingerprint, "voice"),
      generations: (p.generations || []).map(generation => ({
        ...generation,
        voice: normalize(generation.voice, "voice"),
        video: normalize(generation.video, "video")
      }))
    };
    const tmp = path.join(base, "project.json.tmp");
    await fs.writeFile(tmp, JSON.stringify(serial, null, 2), "utf8");
    await fs.rename(tmp, path.join(base, "project.json"));
  }

  base(p: AvatarProject): string {
    return this.baseById.get(p.id) || path.join(this.root, p.folderName || makeFolderName(p.name, p.id));
  }
}
