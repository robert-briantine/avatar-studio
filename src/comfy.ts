import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { ComfyImageRef } from "./types.js";
import type { PromptGraph } from "./workflows.js";

export type ComfyFileRef = { filename: string; subfolder?: string; type?: string };

function imagePath(ref: ComfyImageRef): string {
  return ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
}

function abortError(): Error {
  const error = new Error("Opération arrêtée par l'utilisateur");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ComfyClient {
  constructor(private readonly baseUrl = config.comfyUrl) {}

  async health(): Promise<{ ok: boolean; missingNodes: string[]; missingModels: string[] }> {
    try {
      const r = await fetch(`${this.baseUrl}/object_info`);
      if (!r.ok) return { ok: false, missingNodes: [], missingModels: [] };
      const objectInfo = await r.json() as Record<string, any>;
      const requiredNodes = [
        "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode",
        "EmptySD3LatentImage", "ModelSamplingAuraFlow", "KSampler", "VAEDecode",
        "SaveImage", "LoadImage", "FluxKontextImageScale", "TextEncodeQwenImageEditPlus",
        "FluxKontextMultiReferenceLatentMethod", "VAEEncode", "CFGNorm"
      ];
      const missingNodes = requiredNodes.filter(n => !(n in objectInfo));
      const getChoices = (node: string, input: string): string[] => {
        const value = objectInfo?.[node]?.input?.required?.[input]?.[0];
        return Array.isArray(value) ? value : [];
      };
      const unets = getChoices("UNETLoader", "unet_name");
      const clips = getChoices("CLIPLoader", "clip_name");
      const vaes = getChoices("VAELoader", "vae_name");
      const missingModels = [
        !unets.includes(config.models.baseBf16) ? config.models.baseBf16 : null,
        !unets.includes(config.models.editBf16) ? config.models.editBf16 : null,
        !clips.includes(config.models.clip) ? config.models.clip : null,
        !vaes.includes(config.models.vae) ? config.models.vae : null
      ].filter((x): x is string => Boolean(x));
      return { ok: missingNodes.length === 0 && missingModels.length === 0, missingNodes, missingModels };
    } catch {
      return { ok: false, missingNodes: [], missingModels: [] };
    }
  }


  async nodeInfo(): Promise<Record<string, any>> {
    const r = await fetch(`${this.baseUrl}/object_info`);
    if (!r.ok) throw new Error(`ComfyUI object_info failed: ${r.status} ${await r.text()}`);
    return await r.json() as Record<string, any>;
  }

  async hasNodes(nodeTypes: string[]): Promise<{ ok: boolean; missing: string[] }> {
    try {
      const info = await this.nodeInfo();
      const missing = nodeTypes.filter(name => !(name in info));
      return { ok: missing.length === 0, missing };
    } catch {
      return { ok: false, missing: nodeTypes };
    }
  }

  async uploadImage(buffer: Buffer, filename: string, mime = "image/png", signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(buffer)], { type: mime }), filename);
    form.append("type", "input");
    form.append("overwrite", "true");
    const r = await fetch(`${this.baseUrl}/upload/image`, { method: "POST", body: form, signal });
    if (!r.ok) throw new Error(`ComfyUI upload failed: ${r.status} ${await r.text()}`);
    const data = await r.json() as { name: string; subfolder?: string; type?: string };
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }

  async queue(graph: PromptGraph, signal?: AbortSignal, clientId?: string): Promise<string> {
    throwIfAborted(signal);
    const r = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(clientId ? { prompt: graph, client_id: clientId } : { prompt: graph }),
      signal
    });
    if (!r.ok) throw new Error(`ComfyUI prompt failed: ${r.status} ${await r.text()}`);
    const data = await r.json() as { prompt_id?: string; error?: unknown; node_errors?: unknown };
    if (!data.prompt_id) throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(data)}`);
    return data.prompt_id;
  }


  async queueTracked(
    graph: PromptGraph,
    onEvent: (event: { type: string; node?: string; value?: number; max?: number; promptId?: string }) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<{ promptId: string; close: () => void }> {
    throwIfAborted(signal);
    const clientId = randomUUID();
    const wsUrl = new URL(this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = `${wsUrl.pathname.replace(/\/$/, "")}/ws`;
    wsUrl.search = "";
    wsUrl.searchParams.set("clientId", clientId);

    const socket = new WebSocket(wsUrl.toString());
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connexion WebSocket ComfyUI impossible (timeout).")), 10_000);
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("Connexion WebSocket ComfyUI impossible.")); };
      const onAbort = () => { cleanup(); socket.close(); reject(abortError()); };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    let promptId = "";
    const pending: any[] = [];
    const emit = (message: any) => {
      const type = String(message?.type ?? "");
      const data = message?.data ?? {};
      const eventPromptId = typeof data.prompt_id === "string" ? data.prompt_id : undefined;
      if (eventPromptId && promptId && eventPromptId !== promptId) return;
      void Promise.resolve(onEvent({
        type,
        node: data.node != null ? String(data.node) : undefined,
        value: Number.isFinite(Number(data.value)) ? Number(data.value) : undefined,
        max: Number.isFinite(Number(data.max)) ? Number(data.max) : undefined,
        promptId: eventPromptId
      })).catch(error => console.error("[ComfyUI progress]", error));
    };

    socket.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data);
        if (!promptId) pending.push(message);
        else emit(message);
      } catch {
        // Binary preview frames and unknown messages are intentionally ignored.
      }
    });

    try {
      promptId = await this.queue(graph, signal, clientId);
      for (const message of pending.splice(0)) emit(message);
      return { promptId, close: () => { try { socket.close(); } catch {} } };
    } catch (error) {
      try { socket.close(); } catch {}
      throw error;
    }
  }

  async waitForImage(promptId: string, timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<ComfyImageRef> {
    const started = Date.now();
    const infinite = !Number.isFinite(timeoutMs) || timeoutMs <= 0;
    while (infinite || (Date.now() - started < timeoutMs)) {
      throwIfAborted(signal);
      const r = await fetch(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal });
      if (!r.ok) throw new Error(`ComfyUI history failed: ${r.status} ${await r.text()}`);
      const history = await r.json() as Record<string, any>;
      const entry = history[promptId];
      if (entry) {
        const status = entry.status;
        if (status?.status_str === "error") throw new Error(`ComfyUI execution failed: ${JSON.stringify(status)}`);
        for (const output of Object.values<any>(entry.outputs ?? {})) {
          const image = output?.images?.[0];
          if (image?.filename) return { filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" };
        }
      }
      await delay(1000, signal);
    }
    throw new Error(`Timeout waiting for ComfyUI prompt ${promptId}`);
  }

  async waitForFile(promptId: string, extensions: string[], timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<ComfyFileRef> {
    const wanted = extensions.map(x => x.toLowerCase());
    const started = Date.now();
    const infinite = !Number.isFinite(timeoutMs) || timeoutMs <= 0;
    while (infinite || (Date.now() - started < timeoutMs)) {
      throwIfAborted(signal);
      const r = await fetch(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal });
      if (!r.ok) throw new Error(`ComfyUI history failed: ${r.status} ${await r.text()}`);
      const history = await r.json() as Record<string, any>;
      const entry = history[promptId];
      if (entry) {
        const status = entry.status;
        if (status?.status_str === "error") throw new Error(`ComfyUI execution failed: ${JSON.stringify(status)}`);
        const visit = (value: any): ComfyFileRef | undefined => {
          if (!value) return undefined;
          if (Array.isArray(value)) {
            for (const item of value) { const hit = visit(item); if (hit) return hit; }
            return undefined;
          }
          if (typeof value === "object") {
            if (typeof value.filename === "string") {
              const lower = value.filename.toLowerCase();
              if (wanted.some(ext => lower.endsWith(ext))) {
                return { filename: value.filename, subfolder: value.subfolder ?? "", type: value.type ?? "output" };
              }
            }
            for (const child of Object.values(value)) { const hit = visit(child); if (hit) return hit; }
          }
          return undefined;
        };
        const hit = visit(entry.outputs ?? {});
        if (hit) return hit;
      }
      await delay(1000, signal);
    }
    throw new Error(`Timeout waiting for ComfyUI output ${promptId}`);
  }

  async downloadFile(ref: ComfyFileRef, signal?: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);
    const url = new URL(`${this.baseUrl}/view`);
    url.searchParams.set("filename", ref.filename);
    if (ref.subfolder) url.searchParams.set("subfolder", ref.subfolder);
    url.searchParams.set("type", ref.type ?? "output");
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`ComfyUI file download failed: ${r.status} ${await r.text()}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async downloadImage(ref: ComfyImageRef, signal?: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);
    const url = new URL(`${this.baseUrl}/view`);
    url.searchParams.set("filename", ref.filename);
    if (ref.subfolder) url.searchParams.set("subfolder", ref.subfolder);
    url.searchParams.set("type", ref.type ?? "output");
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`ComfyUI image download failed: ${r.status} ${await r.text()}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async recycleOutputAsInput(ref: ComfyImageRef, prefix = "base", signal?: AbortSignal): Promise<string> {
    const bytes = await this.downloadImage(ref, signal);
    const safe = ref.filename.replace(/[^a-zA-Z0-9_.-]+/g, "_");
    return this.uploadImage(bytes, `${prefix}-${Date.now()}-${safe}`, "image/png", signal);
  }

  async resetImageSession(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);

    // Full reset between batch images:
    // - clears executor/model caches
    // - unloads image models
    // - clears prompt history
    // This is intentionally heavier/slower than normal ComfyUI caching, but
    // guarantees that the next image starts from a clean execution session.
    const free = await fetch(`${this.baseUrl}/free`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal
    });
    if (!free.ok) {
      throw new Error(`ComfyUI strict image reset failed: ${free.status} ${await free.text()}`);
    }

    // History is not needed after the image file has already been downloaded.
    await fetch(`${this.baseUrl}/history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true }),
      signal
    }).catch(() => undefined);

    // /free is consumed by ComfyUI on an idle worker tick.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      const onAbort = () => {
        clearTimeout(timer);
        const error = new Error("Remise à zéro image arrêtée");
        error.name = "AbortError";
        reject(error);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async freeMemory(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);

    // Official ComfyUI /free endpoint: unload loaded models and release cached
    // tensors. GPU utilization can be 0% while these allocations are still
    // resident, so this call is important before loading Qwen3-TTS.
    const r = await fetch(`${this.baseUrl}/free`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal
    });

    if (!r.ok) {
      throw new Error(`ComfyUI memory release failed: ${r.status} ${await r.text()}`);
    }
  }

  async cancelPrompt(promptId?: string): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    tasks.push(fetch(`${this.baseUrl}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: promptId ? JSON.stringify({ prompt_id: promptId }) : undefined
    }).catch(() => undefined));
    if (promptId) {
      tasks.push(fetch(`${this.baseUrl}/queue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [promptId] })
      }).catch(() => undefined));
    }
    await Promise.allSettled(tasks);
  }

  displayPath(ref: ComfyImageRef): string { return imagePath(ref); }
}
