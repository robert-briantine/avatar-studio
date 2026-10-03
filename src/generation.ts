import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ComfyClient } from "./comfy.js";
import { TtsClient, ttsMaxNewTokensForText } from "./tts.js";
import { addExactText } from "./textOverlay.js";
import { applyVisualPreset, buildBasePrompt, buildNegativePrompt, buildStylePrompt, type VisualPreset } from "./prompts.js";
import { buildQwen2512Workflow, buildQwenEdit2511Workflow } from "./workflows.js";
import { alignNarrationBoundaries, concatWavs, createSegmentVideo, createSilence, detectSilences, processAudio, probeDuration, splitWavAtBoundaries, type NarrationBoundary } from "./media.js";
import { getVoicePreset } from "./voicePresets.js";
import type { GenerateOptions } from "./types.js";

export type VoiceProgressEvent = {
  phase: "reference" | "sequence" | "done";
  completed: number;
  total: number;
  sequenceIndex?: number;
  message: string;
  currentStartedAt?: number;
};

export type GenerationContext = {
  signal?: AbortSignal;
  onComfyPrompt?: (promptId: string) => void;
  onVoiceProgress?: (event: VoiceProgressEvent) => void;
  onVoiceCompleted?: (sequenceIndex: number, audio: GeneratedAudio) => void;
};

export type ImageGenerationInput = {
  scenePrompt: string;
  text: string;
  textMode: "integrated" | "exact";
  width: number;
  height: number;
  seed: number;
  textPosition: "top" | "center" | "bottom";
  fontSize: number;
  styleInput?: string;
  upscaleFactor?: number;
  fastPreview?: boolean;
  steps?: number;
  refineQuality?: boolean;
  imageModel?: "bf16";
  baseModelName?: string;
  visualPreset?: VisualPreset;
};

export type VoiceGenerationInput = {
  voiceText: string;
  voicePrompt: string;
  voicePresetId?: string;
  voiceLanguage?: string;
  voiceSpeed?: number;
  voiceSeed?: number;
  voiceReference?: {
    id: string;
    audioPath: string;
    refText: string;
    presetId: string;
  };
};

export type GeneratedImage = { name: string; path: string; url: string; seed: number; pass: "base" | "styled" };
export type GeneratedAudio = { name: string; path: string; url: string; duration: number };
export type GeneratedVideo = { name: string; path: string; url: string; duration: number };


function estimateSpokenSeconds(text: string): number {
  const normalized = text.trim();
  const words = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
  const punctuation = (normalized.match(/[,.!?;:…]/g) || []).length;
  return Math.max(1.5, words / 2.2 + punctuation * 0.12);
}

function plausibleVoiceMaximum(text: string, speed = 1): { expected: number; maximum: number } {
  const safeSpeed = Math.max(0.5, Math.min(2, speed));
  const expected = estimateSpokenSeconds(text) / safeSpeed;
  // Generous enough for dramatic narration, strict enough to reject a runaway.
  const maximum = Math.max(25, expected * 2.5 + 8);
  return { expected, maximum };
}

function assertPlausibleVoiceDuration(text: string, duration: number, speed = 1): void {
  if (!text.trim()) return;
  const { expected, maximum } = plausibleVoiceMaximum(text, speed);
  if (duration > maximum) {
    throw new Error(
      `Voix TTS anormalement longue: ${duration.toFixed(1)} s ` +
      `pour un texte estimé à ${expected.toFixed(1)} s (limite ${maximum.toFixed(1)} s). ` +
      `Qwen a probablement raté sa fin de séquence.`
    );
  }
}

function retryVoiceSeed(baseSeed: number | undefined, sequenceIndex: number, attempt: number): number | undefined {
  if (!Number.isFinite(baseSeed)) return undefined;
  return (Math.floor(baseSeed as number) + sequenceIndex * 1009 + attempt * 104729) % 2_000_000_000;
}

function splitTextForTtsRecovery(text: string): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return [];

  // First choice: real sentence boundaries. This is the important path for the
  // necromancer example: two sentences become two independent EOS opportunities.
  const sentences = normalized
    .split(/(?<=[.!?…])\s+/u)
    .map(s => s.trim())
    .filter(Boolean);

  if (sentences.length > 1) return sentences;

  // Second choice: punctuation boundary for a long single sentence.
  const clauses = normalized
    .split(/(?<=[;:])\s+|(?<=,)\s+/u)
    .map(s => s.trim())
    .filter(Boolean);

  if (clauses.length > 1) return clauses;

  // Last resort: split a sufficiently long sentence near the middle, preserving
  // complete words. Short phrases are kept whole because splitting them hurts
  // prosody more than it helps EOS recovery.
  const words = normalized.split(/\s+/);
  if (words.length >= 14) {
    const cut = Math.ceil(words.length / 2);
    return [
      words.slice(0, cut).join(" "),
      words.slice(cut).join(" ")
    ].filter(Boolean);
  }

  return [normalized];
}

export class GeneratorService {
  constructor(
    private readonly outputsDir: string,
    private readonly comfy = new ComfyClient(),
    private readonly tts = new TtsClient()
  ) {}

  async uploadStyle(buffer: Buffer, originalName = "style.png", mime = "image/png", signal?: AbortSignal): Promise<string> {
    const ext = path.extname(originalName) || ".png";
    return this.comfy.uploadImage(buffer, `style-${randomUUID()}${ext}`, mime, signal);
  }

  async generateImage(input: ImageGenerationInput, context: GenerationContext = {}): Promise<GeneratedImage> {
    const options: GenerateOptions = {
      scenePrompt: applyVisualPreset(input.scenePrompt, input.visualPreset || "none"),
      text: input.text,
      textMode: input.textMode,
      width: input.width,
      height: input.height,
      seed: input.seed,
      textPosition: input.textPosition,
      fontSize: input.fontSize
    };

    // Native Qwen-Image-2512 ComfyUI graph.
    // Keep stable numeric node ids exactly like the official template.
    // ComfyUI itself invalidates cached nodes when prompt/seed inputs change.
    const baseGraph = buildQwen2512Workflow({
      prompt: buildBasePrompt(options),
      negativePrompt: buildNegativePrompt(input.scenePrompt),
      width: input.width,
      height: input.height,
      seed: input.seed,
      modelName: input.baseModelName,
      steps: Math.max(1, Math.min(80, Math.floor(input.steps ?? (input.fastPreview ? 12 : 50)))),
      cfg: 4
    });

    const baseId = await this.comfy.queue(baseGraph, context.signal);
    context.onComfyPrompt?.(baseId);
    const baseRef = await this.comfy.waitForImage(baseId, undefined, context.signal);

    let finalRef = baseRef;
    let pass: "base" | "styled" = "base";

    const shouldRefine = !input.fastPreview && (Boolean(input.refineQuality) || Boolean(input.styleInput));
    if (shouldRefine) {
      const baseInput = await this.comfy.recycleOutputAsInput(baseRef, "quality-base", context.signal);

      // Deliberate model switch: do not keep two ~40.9 GB BF16 diffusion
      // models resident simultaneously.
      await this.comfy.freeMemory(context.signal);

      const editGraph = buildQwenEdit2511Workflow({
        baseImage: baseInput,
        styleImage: input.styleInput,
        prompt: buildStylePrompt(options, Boolean(input.styleInput), input.visualPreset || "none"),
        seed: input.seed + 1,
        steps: 20,
        cfg: 4
      });

      const editId = await this.comfy.queue(editGraph, context.signal);
      context.onComfyPrompt?.(editId);
      finalRef = await this.comfy.waitForImage(editId, undefined, context.signal);
      pass = "styled";
    }

    let imageBytes = await this.comfy.downloadImage(finalRef, context.signal);

    if (input.fastPreview) {
      // Qwen-Image-2512 is generated at its supported 4:3 size (1472x1104),
      // then reduced to the requested 640x480 preview. This avoids the broken
      // direct 640x480 latent while keeping preview generation much faster via
      // the 12-step sampler.
      imageBytes = await sharp(imageBytes)
        .resize(640, 480, { kernel: sharp.kernel.lanczos3 })
        .png({ compressionLevel: 6 })
        .toBuffer();

      if (input.textMode === "exact" && input.text.trim()) {
        const previewFont = Math.max(18, Math.round(input.fontSize * (640 / 1472)));
        imageBytes = await addExactText(imageBytes, input.text, {
          position: input.textPosition,
          fontSize: previewFont
        });
      }
    } else {
      if (input.textMode === "exact" && input.text.trim()) {
        imageBytes = await addExactText(imageBytes, input.text, {
          position: input.textPosition,
          fontSize: input.fontSize
        });
      }

      const upscaleFactor = Math.max(1, Math.min(2, input.upscaleFactor ?? 1));
      if (upscaleFactor > 1.001) {
        const targetWidth = Math.round(input.width * upscaleFactor);
        const targetHeight = Math.round(input.height * upscaleFactor);
        imageBytes = await sharp(imageBytes)
          .resize(targetWidth, targetHeight, { kernel: sharp.kernel.lanczos3 })
          .sharpen(0.55)
          .png({ compressionLevel: 6 })
          .toBuffer();
      }
    }

    const stem = `${Date.now()}-${randomUUID()}`;
    const name = `image-${stem}.png`;
    const outputPath = path.join(this.outputsDir, name);
    await fs.writeFile(outputPath, imageBytes);
    return { name, path: outputPath, url: `/outputs/${name}`, seed: input.seed, pass };
  }

  async generateVoice(input: VoiceGenerationInput, context: GenerationContext = {}): Promise<GeneratedAudio> {
    const stem = `${Date.now()}-${randomUUID()}`;
    const name = `voice-${stem}.wav`;
    const outputPath = path.join(this.outputsDir, name);

    if (!input.voiceText.trim()) {
      await createSilence(outputPath, undefined, context.signal);
      const duration = await probeDuration(outputPath, context.signal);
      return { name, path: outputPath, url: `/outputs/${name}`, duration };
    }

    const preset = getVoicePreset(input.voiceReference?.presetId || input.voicePresetId);
    const prompt = input.voicePrompt.trim() || preset.prompt;
    let rawAudio: Buffer;

    if (input.voiceReference) {
      const tokenBudget = ttsMaxNewTokensForText(input.voiceText, 4096);
      let acceptedRaw: Buffer | undefined;
      let lastCloneError: Error | undefined;

      // Individual-sequence regeneration uses the same diverse retry strategy as
      // the global batch. This makes the "Régénérer voix" button robust too.
      for (let attempt = 0; attempt < 4; attempt++) {
        const attemptSeed = retryVoiceSeed(input.voiceSeed, 0, attempt);
        try {
          const candidate = await this.tts.clone({
            text: input.voiceText,
            language: input.voiceLanguage || "French",
            refAudioPath: input.voiceReference.audioPath,
            refText: input.voiceReference.refText,
            referenceKey: input.voiceReference.id,
            seed: attemptSeed,
            maxNewTokens: tokenBudget,
            retryProfile: attempt
          }, context.signal);

          const probeRawPath = path.join(this.outputsDir, `.raw-probe-${Date.now()}-${randomUUID()}.wav`);
          const probeFinalPath = path.join(this.outputsDir, `.final-probe-${Date.now()}-${randomUUID()}.wav`);
          await fs.writeFile(probeRawPath, candidate);

          try {
            const speed = Math.max(0.5, Math.min(2, input.voiceSpeed ?? 1));
            const filters: string[] = [];
            if (preset.ffmpegFilter) filters.push(preset.ffmpegFilter);
            if (Math.abs(speed - 1) >= 0.001) filters.push(`atempo=${speed.toFixed(6)}`);
            const probeFilter = filters.length ? filters.join(",") : undefined;

            await processAudio(probeRawPath, probeFinalPath, probeFilter, context.signal);
            const measuredDuration = await probeDuration(probeFinalPath, context.signal);
            assertPlausibleVoiceDuration(input.voiceText, measuredDuration, input.voiceSpeed ?? 1);

            acceptedRaw = candidate;
            console.log(
              `[tts] régénération individuelle acceptée au profile ${attempt}: ${measuredDuration.toFixed(2)} s`
            );
            break;
          } finally {
            await fs.rm(probeRawPath, { force: true });
            await fs.rm(probeFinalPath, { force: true });
          }
        } catch (error) {
          lastCloneError = error instanceof Error ? error : new Error(String(error));
          console.warn(`[tts] régénération individuelle profile ${attempt} rejetée: ${lastCloneError.message}`);
        }
      }

      if (!acceptedRaw) {
        throw new Error(
          `Échec de la voix clonée après 4 stratégies de génération. ` +
          `${lastCloneError?.message || "Sortie vocale incohérente."}`
        );
      }
      rawAudio = acceptedRaw;
    } else {
      rawAudio = await this.tts.synthesize({
        text: input.voiceText,
        voicePrompt: prompt,
        language: input.voiceLanguage || "French",
        speed: input.voiceSpeed ?? 1,
        seed: input.voiceSeed
      }, context.signal);
    }

    const rawPath = path.join(this.outputsDir, `.raw-${stem}.wav`);
    await fs.writeFile(rawPath, rawAudio);
    try {
      const speed = Math.max(0.5, Math.min(2, input.voiceSpeed ?? 1));
      const filters: string[] = [];
      if (preset.ffmpegFilter) filters.push(preset.ffmpegFilter);
      if (Math.abs(speed - 1) >= 0.001) filters.push(`atempo=${speed.toFixed(6)}`);
      const finalFilter = filters.length ? filters.join(",") : undefined;
      await processAudio(rawPath, outputPath, finalFilter, context.signal);
    } finally {
      await fs.rm(rawPath, { force: true });
    }
    const duration = await probeDuration(outputPath, context.signal);
    assertPlausibleVoiceDuration(input.voiceText, duration, input.voiceSpeed ?? 1);
    return { name, path: outputPath, url: `/outputs/${name}`, duration };
  }


  async testVoice(input: VoiceGenerationInput, context: GenerationContext = {}) {
    if (!input.voiceText.trim()) throw new Error("Le texte à lire est vide");

    const preset = getVoicePreset(input.voicePresetId);
    const prompt = input.voicePrompt.trim() || preset.prompt;
    if (!prompt) throw new Error("Le prompt VoiceDesign est vide");

    const stem = `${Date.now()}-${randomUUID()}`;
    const rawName = `voice-test-raw-${stem}.wav`;
    const finalName = `voice-test-final-${stem}.wav`;
    const rawPath = path.join(this.outputsDir, rawName);
    const finalPath = path.join(this.outputsDir, finalName);

    const rawAudio = await this.tts.synthesize({
      text: input.voiceText,
      voicePrompt: prompt,
      language: input.voiceLanguage || "French",
      speed: 1,
      seed: input.voiceSeed
    }, context.signal);

    await fs.writeFile(rawPath, rawAudio);

    const speed = Math.max(0.5, Math.min(2, input.voiceSpeed ?? 1));
    const filters: string[] = [];
    if (preset.ffmpegFilter) filters.push(preset.ffmpegFilter);
    if (Math.abs(speed - 1) >= 0.001) filters.push(`atempo=${speed.toFixed(6)}`);
    const finalFilter = filters.length ? filters.join(",") : undefined;

    await processAudio(rawPath, finalPath, finalFilter, context.signal);

    const [rawDuration, finalDuration] = await Promise.all([
      probeDuration(rawPath, context.signal),
      probeDuration(finalPath, context.signal)
    ]);

    assertPlausibleVoiceDuration(input.voiceText, finalDuration, input.voiceSpeed ?? 1);

    return {
      presetId: preset.id,
      presetLabel: preset.label,
      prompt,
      seed: input.voiceSeed,
      ffmpegFilter: preset.ffmpegFilter || "",
      rawPath,
      rawUrl: `/outputs/${rawName}`,
      rawDuration,
      finalPath,
      finalUrl: `/outputs/${finalName}`,
      finalDuration
    };
  }


  async generateBatchVoices(inputs: VoiceGenerationInput[], context: GenerationContext = {}) {
    if (!inputs.length) throw new Error("Aucune séquence vocale");

    const audios: Array<GeneratedAudio | undefined> = new Array(inputs.length);
    const voiced = inputs
      .map((input, index) => ({ input, index, text: input.voiceText.trim() }))
      .filter(item => item.text.length > 0);

    if (voiced.length) {
      const first = voiced[0].input;
      const preset = getVoicePreset(first.voiceReference?.presetId || first.voicePresetId);
      const prompt = first.voicePrompt.trim() || preset.prompt;
      const language = first.voiceLanguage || "French";

      let refAudioPath: string;
      let refText: string;
      let referenceKey: string;
      let autoReferencePath: string | undefined;

      if (first.voiceReference) {
        refAudioPath = first.voiceReference.audioPath;
        refText = first.voiceReference.refText;
        referenceKey = first.voiceReference.id;
      } else {
        refText =
          "Dans les profondeurs de ce royaume, ma voix résonne lentement. " +
          "Chaque mot garde la même présence, le même timbre et la même force.";

        context.onVoiceProgress?.({
          phase: "reference",
          completed: 0,
          total: voiced.length,
          message: "Création de la référence vocale",
          currentStartedAt: Date.now()
        });

        const refBytes = await this.tts.synthesize({
          text: refText,
          voicePrompt: prompt,
          language,
          seed: first.voiceSeed,
          maxNewTokens: 2048
        }, context.signal);

        const refStem = `${Date.now()}-${randomUUID()}`;
        autoReferencePath = path.join(this.outputsDir, `.auto-voice-reference-${refStem}.wav`);
        await fs.writeFile(autoReferencePath, refBytes);
        refAudioPath = autoReferencePath;
        referenceKey = `auto-${refStem}`;

        await this.tts.releaseModels();
      }

      const speed = Math.max(0.5, Math.min(2, first.voiceSpeed ?? 1));
      const filters: string[] = [];
      if (preset.ffmpegFilter) filters.push(preset.ffmpegFilter);
      if (Math.abs(speed - 1) >= 0.001) filters.push(`atempo=${speed.toFixed(6)}`);
      const finalFilter = filters.length ? filters.join(",") : undefined;

      try {
        for (let i = 0; i < voiced.length; i++) {
          if (context.signal?.aborted) {
            const error = new Error("Génération vocale arrêtée par l'utilisateur");
            error.name = "AbortError";
            throw error;
          }

          const item = voiced[i];
          context.onVoiceProgress?.({
            phase: "sequence",
            completed: i,
            total: voiced.length,
            sequenceIndex: item.index,
            message: `Voix ${i + 1}/${voiced.length} — séquence ${item.index + 1}`,
            currentStartedAt: Date.now()
          });

          // One independent local HTTP request per phrase. A stochastic EOS
          // failure must never become an accepted 30/60-second sequence.
          const maxAttempts = 4;
          const tokenBudget = ttsMaxNewTokensForText(item.text, 4096);
          const tokenBudgetSeconds = tokenBudget / 12.5;
          let audio: GeneratedAudio | undefined;
          let lastError: Error | undefined;

          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (context.signal?.aborted) {
              const error = new Error("Génération vocale arrêtée par l'utilisateur");
              error.name = "AbortError";
              throw error;
            }

            const attemptSeed = retryVoiceSeed(
              item.input.voiceSeed ?? first.voiceSeed,
              item.index,
              attempt
            );

            if (attempt > 0) {
              context.onVoiceProgress?.({
                phase: "sequence",
                completed: i,
                total: voiced.length,
                sequenceIndex: item.index,
                message: `Voix ${i + 1}/${voiced.length} — retry ${attempt + 1}/${maxAttempts}`,
                currentStartedAt: Date.now()
              });
            }

            console.log(
              `[tts] séquence ${item.index + 1}, tentative ${attempt + 1}/${maxAttempts}, ` +
              `budget=${tokenBudget} (~${tokenBudgetSeconds.toFixed(1)}s), seed=${attemptSeed ?? "auto"}`
            );

            const rawBytes = await this.tts.clone({
              text: item.text,
              language,
              refAudioPath,
              refText,
              referenceKey,
              seed: attemptSeed,
              maxNewTokens: tokenBudget,
              retryProfile: attempt
            }, context.signal);

            const stem = `${Date.now()}-${randomUUID()}-${String(item.index + 1).padStart(3, "0")}-a${attempt + 1}`;
            const rawPath = path.join(this.outputsDir, `.batch-raw-${stem}.wav`);
            const name = `voice-${stem}.wav`;
            const outputPath = path.join(this.outputsDir, name);

            await fs.writeFile(rawPath, rawBytes);
            try {
              await processAudio(rawPath, outputPath, finalFilter, context.signal);
              const duration = await probeDuration(outputPath, context.signal);

              try {
                assertPlausibleVoiceDuration(item.text, duration, item.input.voiceSpeed ?? 1);
                // Hitting most of the codec budget is another strong EOS-failure signal.
                if (duration >= tokenBudgetSeconds * 0.85) {
                  throw new Error(
                    `Voix proche du plafond TTS: ${duration.toFixed(1)} s / ${tokenBudgetSeconds.toFixed(1)} s`
                  );
                }

                audio = { name, path: outputPath, url: `/outputs/${name}`, duration };
                console.log(`[tts] séquence ${item.index + 1} acceptée: ${duration.toFixed(2)} s`);
                break;
              } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                console.warn(
                  `[tts] séquence ${item.index + 1} rejetée tentative ${attempt + 1}: ${lastError.message}`
                );
                await fs.rm(outputPath, { force: true });
              }
            } finally {
              await fs.rm(rawPath, { force: true });
            }
          }

          if (!audio) {
            const chunks = splitTextForTtsRecovery(item.text);

            if (chunks.length > 1) {
              console.warn(
                `[tts] séquence ${item.index + 1}: les ${maxAttempts} générations complètes ont échoué; ` +
                `fallback par ${chunks.length} phrase(s)/morceau(x)`
              );

              context.onVoiceProgress?.({
                phase: "sequence",
                completed: i,
                total: voiced.length,
                sequenceIndex: item.index,
                message: `Voix ${i + 1}/${voiced.length} — récupération par phrases`,
                currentStartedAt: Date.now()
              });

              const chunkPaths: string[] = [];
              try {
                for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
                  const chunkText = chunks[chunkIndex];
                  let chunkOk = false;
                  let chunkError: Error | undefined;

                  // Three genuinely different sampling profiles for each chunk.
                  for (let chunkAttempt = 0; chunkAttempt < 3; chunkAttempt++) {
                    const chunkBudget = ttsMaxNewTokensForText(chunkText, 4096);
                    const chunkBudgetSeconds = chunkBudget / 12.5;
                    const chunkSeed = retryVoiceSeed(
                      item.input.voiceSeed ?? first.voiceSeed,
                      item.index * 17 + chunkIndex,
                      chunkAttempt + 1
                    );

                    console.log(
                      `[tts] séquence ${item.index + 1} morceau ${chunkIndex + 1}/${chunks.length}, ` +
                      `tentative ${chunkAttempt + 1}/3, profile=${chunkAttempt + 1}, ` +
                      `budget=${chunkBudget} (~${chunkBudgetSeconds.toFixed(1)}s), seed=${chunkSeed ?? "auto"}`
                    );

                    const chunkRaw = await this.tts.clone({
                      text: chunkText,
                      language,
                      refAudioPath,
                      refText,
                      referenceKey,
                      seed: chunkSeed,
                      maxNewTokens: chunkBudget,
                      retryProfile: chunkAttempt + 1
                    }, context.signal);

                    const chunkStem =
                      `${Date.now()}-${randomUUID()}-${String(item.index + 1).padStart(3, "0")}` +
                      `-chunk${chunkIndex + 1}-a${chunkAttempt + 1}`;
                    const chunkRawPath = path.join(this.outputsDir, `.batch-raw-${chunkStem}.wav`);
                    const chunkPath = path.join(this.outputsDir, `.batch-chunk-${chunkStem}.wav`);

                    await fs.writeFile(chunkRawPath, chunkRaw);
                    try {
                      await processAudio(chunkRawPath, chunkPath, finalFilter, context.signal);
                      const chunkDuration = await probeDuration(chunkPath, context.signal);
                      assertPlausibleVoiceDuration(chunkText, chunkDuration, item.input.voiceSpeed ?? 1);

                      if (chunkDuration >= chunkBudgetSeconds * 0.90) {
                        throw new Error(
                          `morceau proche du plafond TTS: ${chunkDuration.toFixed(1)} s / ` +
                          `${chunkBudgetSeconds.toFixed(1)} s`
                        );
                      }

                      chunkPaths.push(chunkPath);
                      chunkOk = true;
                      console.log(
                        `[tts] séquence ${item.index + 1} morceau ${chunkIndex + 1} accepté: ` +
                        `${chunkDuration.toFixed(2)} s`
                      );
                      break;
                    } catch (error) {
                      chunkError = error instanceof Error ? error : new Error(String(error));
                      await fs.rm(chunkPath, { force: true });
                      console.warn(
                        `[tts] séquence ${item.index + 1} morceau ${chunkIndex + 1} rejeté: ` +
                        `${chunkError.message}`
                      );
                    } finally {
                      await fs.rm(chunkRawPath, { force: true });
                    }
                  }

                  if (!chunkOk) {
                    throw new Error(
                      `Échec du morceau ${chunkIndex + 1}/${chunks.length}: ` +
                      `${chunkError?.message || "sortie vocale incohérente"}`
                    );
                  }
                }

                const stem =
                  `${Date.now()}-${randomUUID()}-${String(item.index + 1).padStart(3, "0")}-recovered`;
                const name = `voice-${stem}.wav`;
                const outputPath = path.join(this.outputsDir, name);
                const duration = await concatWavs(chunkPaths, outputPath, context.signal);

                // The concatenated result may naturally be a little longer than
                // the simple word-rate estimate, so use the regular generous guard.
                assertPlausibleVoiceDuration(item.text, duration, item.input.voiceSpeed ?? 1);

                audio = { name, path: outputPath, url: `/outputs/${name}`, duration };
                console.log(
                  `[tts] séquence ${item.index + 1} récupérée par phrases: ${duration.toFixed(2)} s`
                );
              } finally {
                await Promise.all(chunkPaths.map(p => fs.rm(p, { force: true })));
              }
            }
          }

          if (!audio) {
            throw new Error(
              `Échec TTS séquence ${item.index + 1} après ${maxAttempts} stratégies complètes ` +
              `et récupération par phrases. ${lastError?.message || "Sortie vocale incohérente."}`
            );
          }

          audios[item.index] = audio;
          context.onVoiceCompleted?.(item.index, audio);
          context.onVoiceProgress?.({
            phase: "sequence",
            completed: i + 1,
            total: voiced.length,
            sequenceIndex: item.index,
            message: `Voix terminées : ${i + 1}/${voiced.length}`
          });
        }
      } finally {
        if (autoReferencePath) {
          await fs.rm(autoReferencePath, { force: true }).catch(() => undefined);
        }
      }

      context.onVoiceProgress?.({
        phase: "done",
        completed: voiced.length,
        total: voiced.length,
        message: `Voix terminées : ${voiced.length}/${voiced.length}`
      });
    }

    for (let i = 0; i < inputs.length; i++) {
      if (audios[i]) continue;
      const stem = `${Date.now()}-${randomUUID()}-${String(i + 1).padStart(3, "0")}`;
      const name = `voice-${stem}.wav`;
      const outputPath = path.join(this.outputsDir, name);
      await createSilence(outputPath, undefined, context.signal);
      const audio: GeneratedAudio = {
        name,
        path: outputPath,
        url: `/outputs/${name}`,
        duration: await probeDuration(outputPath, context.signal)
      };
      audios[i] = audio;
      context.onVoiceCompleted?.(i, audio);
    }

    return {
      audios: audios as GeneratedAudio[],
      batchCount: voiced.length
    };
  }

  async createSegment(imagePath: string, audioPath: string, context: GenerationContext = {}): Promise<GeneratedVideo> {
    const stem = `${Date.now()}-${randomUUID()}`;
    const name = `segment-${stem}.mp4`;
    const outputPath = path.join(this.outputsDir, name);
    const duration = await createSegmentVideo(imagePath, audioPath, outputPath, context.signal);
    return { name, path: outputPath, url: `/outputs/${name}`, duration };
  }

  async generateOne(input: ImageGenerationInput & VoiceGenerationInput & { makeVideo?: boolean }, context: GenerationContext = {}) {
    const image = await this.generateImage(input, context);

    let audio: GeneratedAudio | undefined;
    let audioError: string | undefined;
    try { audio = await this.generateVoice(input, context); }
    catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      audioError = error instanceof Error ? error.message : String(error);
    }
    let video: GeneratedVideo | undefined;
    if (input.makeVideo && audio) video = await this.createSegment(image.path, audio.path, context);
    return {
      imageUrl: image.url,
      imagePath: image.path,
      audioUrl: audio?.url,
      audioPath: audio?.path,
      videoUrl: video?.url,
      videoPath: video?.path,
      duration: video?.duration,
      audioError,
      seed: image.seed,
      pass: image.pass,
      promptUsed: input.scenePrompt,
      imageModel: input.imageModel || "bf16",
      baseModelName: input.baseModelName
    };
  }
}
