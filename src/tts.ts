import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { config } from "./config.js";

export interface TtsRequest {
  text: string;
  voicePrompt: string;
  language?: string;
  speed?: number;
  seed?: number;
  maxNewTokens?: number;
}

export interface TtsCloneRequest {
  text: string;
  language?: string;
  refAudioPath: string;
  refText: string;
  referenceKey: string;
  seed?: number;
  maxNewTokens?: number;
  retryProfile?: number;
}


export interface TtsBatchRequest {
  texts: string[];
  voicePrompt: string;
  language?: string;
  seed?: number;
  maxNewTokens?: number;
}

export interface TtsCloneBatchRequest {
  texts: string[];
  language?: string;
  refAudioPath: string;
  refText: string;
  referenceKey: string;
  seed?: number;
  maxNewTokens?: number;
}


/**
 * Qwen3-TTS 12Hz can keep generating until max_new_tokens when EOS is missed.
 * A fixed 4096 token budget is roughly 5m28 of codec output, which explains
 * pathological WAVs with a normal phrase followed by minutes of silence.
 *
 * This is NOT a wall-clock timeout. The budget scales with the amount of text
 * and remains generous without giving short phrases a one-minute floor.
 */
export function ttsMaxNewTokensForText(text: string, requested?: number): number {
  const normalized = text.trim();
  const words = normalized ? normalized.split(/\s+/).filter(Boolean).length : 1;
  const punctuation = (normalized.match(/[,.!?;:…]/g) || []).length;

  // Deliberately conservative French narration estimate (~126 wpm), plus
  // punctuation pauses. It overestimates normal narration rather than cutting it.
  const estimatedSeconds = Math.max(2, words / 2.1 + punctuation * 0.12);
  const safeSeconds = Math.max(28, estimatedSeconds * 3.2 + 10);

  // Short phrases no longer inherit the v5.35 one-minute floor.
  // 384 tokens still leave roughly 30 seconds of codec output, which is already
  // very generous for a short narration sentence.
  const automatic = Math.max(384, Math.min(4096, Math.ceil(safeSeconds * 12.5)));

  if (!Number.isFinite(requested)) return automatic;
  return Math.max(384, Math.min(automatic, Math.floor(requested as number), 4096));
}

type TtsBatchResponse = {
  sample_rate?: number;
  format?: string;
  audio?: string[];
};

export interface TtsHealth {
  ok: boolean;
  url: string;
  modelId?: string;
  backend?: string;
  ready?: boolean;
  error?: string;
}

function linkedTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Timeout TTS")), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}

function linkedAbortSignal(parent: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);

  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => parent?.removeEventListener("abort", onAbort)
  };
}


type LongHttpResponse = {
  statusCode: number;
  body: Buffer;
};

function postJsonNoTimeout(
  urlString: string,
  payload: unknown,
  parentSignal?: AbortSignal
): Promise<LongHttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = Buffer.from(JSON.stringify(payload));
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    let request: ReturnType<typeof http.request> | ReturnType<typeof https.request>;

    const cleanup = () => parentSignal?.removeEventListener("abort", onAbort);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      const error = new Error("Opération arrêtée par l'utilisateur");
      error.name = "AbortError";
      request.destroy(error);
    };

    request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      agent: false,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "Connection": "close"
      }
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", fail);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks)
        });
      });
    });

    // No application, headers or socket timeout for long local inference.
    request.setTimeout(0);
    request.on("error", fail);

    if (parentSignal) {
      if (parentSignal.aborted) {
        onAbort();
        return;
      }
      parentSignal.addEventListener("abort", onAbort, { once: true });
    }

    request.write(body);
    request.end();
  });
}

function decodeBatchAudio(body: TtsBatchResponse, expected: number): Buffer[] {
  if (!Array.isArray(body.audio)) throw new Error("Réponse TTS batch invalide: audio[] absent");
  if (body.audio.length !== expected) {
    throw new Error(`Réponse TTS batch invalide: ${body.audio.length} audio(s) pour ${expected} texte(s)`);
  }
  return body.audio.map((value, index) => {
    if (typeof value !== "string" || !value) throw new Error(`Audio batch ${index + 1} vide`);
    return Buffer.from(value, "base64");
  });
}

export class TtsClient {
  private readonly baseUrl = config.ttsUrl;

  async health(): Promise<TtsHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return { ok: false, url: this.baseUrl, error: `HTTP ${response.status}` };

      const body: any = await response.json().catch(() => ({}));
      const modelId = String(body?.backend?.model_id ?? "");
      const baseModelId = String(body?.backend?.base_model_id ?? "");
      const backend = String(body?.backend?.name ?? "");
      const ready = body?.backend?.ready === true;
      const cloneReady = body?.backend?.clone_ready === true;
      const isVoiceDesign = /VoiceDesign/i.test(modelId);
      const isBase = /1\.7B-Base/i.test(baseModelId) || /Base/i.test(baseModelId);
      const isDirect = backend === "direct-voice-design-clone" || backend === "direct-voice-design-clone-lazy";

      return {
        ok: Boolean(isVoiceDesign && isBase && isDirect && ready && cloneReady),
        url: this.baseUrl,
        modelId: `${modelId} + ${baseModelId}`,
        backend,
        ready: ready && cloneReady,
        error:
          !isDirect
            ? `Serveur TTS incompatible actif: ${backend || "inconnu"}. Lance le serveur VoiceDesign + Clone de l'application.`
            : !isVoiceDesign
              ? `Mauvais checkpoint VoiceDesign: ${modelId || "inconnu"}`
              : !isBase
                ? `Mauvais checkpoint Base: ${baseModelId || "inconnu"}`
                : !(ready && cloneReady)
                  ? "VoiceDesign ou VoiceClone n'est pas prêt"
                  : undefined
      };
    } catch (error) {
      return { ok: false, url: this.baseUrl, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async assertReady(): Promise<void> {
    let health = await this.health();
    if (health.ok) return;

    // The previous generation may have been hard-stopped. Restart the local
    // TTS service automatically instead of asking the user to relaunch the app.
    await this.startLocalServer();

    for (let i = 0; i < 120; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      health = await this.health();
      if (health.ok) return;
    }

    throw new Error(
      health.error ||
      "Qwen3-TTS ne redémarre pas. Consulte /tmp/qwen3-tts-dgx.log"
    );
  }

  private async startLocalServer(): Promise<void> {
    const script = path.resolve(process.cwd(), "start-tts-only.sh");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/bash", [script], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: { ...process.env }
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  async hardStop(): Promise<void> {
    // First ask the FastAPI process to terminate itself. This endpoint does not
    // wait on the model lock, so it works even while PyTorch is generating.
    try {
      await fetch(`${this.baseUrl}/v1/process/terminate`, {
        method: "POST",
        signal: AbortSignal.timeout(2000)
      });
    } catch {
      // Connection may disappear immediately: this is expected.
    }

    // Give the kernel a moment to release CUDA/unified-memory resources.
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const health = await this.health();
      if (!health.ok) return;
    }
  }

  async synthesize(request: TtsRequest, parentSignal?: AbortSignal): Promise<Buffer> {
    await this.assertReady();

    const voicePrompt = request.voicePrompt.trim();
    if (!voicePrompt) throw new Error("Le prompt VoiceDesign est vide");

    const response = await postJsonNoTimeout(
      `${this.baseUrl}/v1/audio/speech`,
      {
        input: request.text,
        language: request.language?.trim() || config.tts.language,
        instructions: voicePrompt,
        response_format: "wav",
        seed: Number.isFinite(request.seed) ? Math.floor(request.seed as number) : undefined,
        max_new_tokens: ttsMaxNewTokensForText(request.text, request.maxNewTokens)
      },
      parentSignal
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Qwen3-TTS VoiceDesign direct failed: ${response.statusCode} ${response.body.toString("utf8")}`);
    }
    return response.body;
  }

  async clone(request: TtsCloneRequest, parentSignal?: AbortSignal): Promise<Buffer> {
    await this.assertReady();
    if (!request.refAudioPath.trim()) throw new Error("Référence audio absente");

    const response = await postJsonNoTimeout(
      `${this.baseUrl}/v1/audio/clone`,
      {
        input: request.text,
        language: request.language?.trim() || config.tts.language,
        ref_audio: request.refAudioPath,
        ref_text: request.refText,
        reference_key: request.referenceKey,
        response_format: "wav",
        seed: Number.isFinite(request.seed) ? Math.floor(request.seed as number) : undefined,
        max_new_tokens: ttsMaxNewTokensForText(request.text, request.maxNewTokens),
        retry_profile: Number.isFinite(request.retryProfile) ? Math.max(0, Math.floor(request.retryProfile as number)) : 0
      },
      parentSignal
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Qwen3-TTS VoiceClone failed: ${response.statusCode} ${response.body.toString("utf8")}`);
    }
    return response.body;
  }

  async synthesizeBatch(request: TtsBatchRequest, parentSignal?: AbortSignal): Promise<Buffer[]> {
    const results: Buffer[] = [];
    for (const text of request.texts) {
      results.push(await this.synthesize({
        text,
        voicePrompt: request.voicePrompt,
        language: request.language,
        seed: request.seed,
        maxNewTokens: request.maxNewTokens
      }, parentSignal));
    }
    return results;
  }

  async cloneBatch(request: TtsCloneBatchRequest, parentSignal?: AbortSignal): Promise<Buffer[]> {
    const results: Buffer[] = [];
    for (const text of request.texts) {
      results.push(await this.clone({
        text,
        language: request.language,
        refAudioPath: request.refAudioPath,
        refText: request.refText,
        referenceKey: request.referenceKey,
        seed: request.seed,
        maxNewTokens: request.maxNewTokens
      }, parentSignal));
    }
    return results;
  }

  async releaseModels(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/v1/models/release`, {
        method: "POST",
        signal: AbortSignal.timeout(5000)
      });
    } catch {
      // Best effort only.
    }
  }

}
