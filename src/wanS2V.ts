import type { PromptGraph } from "./workflows.js";

export const WAN_S2V_CHUNK_FRAMES = 77;
export const WAN_S2V_FPS = 16;
export const WAN_S2V_OVERLAP_FRAMES = 8; // 0,5 s : mêmes instants audio dans les deux fenêtres.
// Une reprise avant chaque bloc natif évite toute extension récursive. Avec les
// 8 images rejouées pour le raccord, 69 nouvelles images + 8 = 77 exactement.
export const WAN_S2V_STABILIZATION_SECONDS =
  (WAN_S2V_CHUNK_FRAMES - WAN_S2V_OVERLAP_FRAMES) / WAN_S2V_FPS;
export const WAN_S2V_MOTION_FRAMES = 73; // Contexte ref_motion attendu par le nœud natif Wan S2V.
export const WAN_S2V_STABLE_NODES = [
  "TrimAudioDuration", "ImageFromBatch", "ImageBatch", "RepeatImageBatch", "DGXPrepareWanHandoff"
] as const;
export type WanVideoWindow = {
  startFrame: number;
  frames: number;
  resetToOriginal?: boolean;
  silence?: { start: number; end: number; duration: number };
};
export type WanSilenceInterval = { start: number; end: number; duration: number };

export function parseWanStabilizationSeconds(value: unknown = WAN_S2V_STABILIZATION_SECONDS): number {
  const seconds = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) {
    throw new RangeError("La durée avant stabilisation doit être comprise entre 1 et 120 secondes.");
  }
  // Wan travaille à 16 fps : toutes les étapes partagent le même instant exact.
  return Math.round(seconds * WAN_S2V_FPS) / WAN_S2V_FPS;
}

export function planWanS2VWindows(
  durationSeconds: number, stabilizationSeconds = WAN_S2V_STABILIZATION_SECONDS
): WanVideoWindow[] {
  const requestedFrames = Math.max(1, Math.ceil(durationSeconds * WAN_S2V_FPS));
  const intervalFrames = parseWanStabilizationSeconds(stabilizationSeconds) * WAN_S2V_FPS;
  // Le chevauchement vient APRÈS le délai choisi : avec le profil fixe, une
  // reprise commence à l'image 69 depuis l'image 68, et la fenêtre fait les
  // 77 images exactes d'un bloc Wan natif.
  const windowFrames = intervalFrames + WAN_S2V_OVERLAP_FRAMES;
  const windows: WanVideoWindow[] = [];
  for (let startFrame = 0; startFrame < requestedFrames; startFrame += intervalFrames) {
    const frames = Math.min(windowFrames, requestedFrames - startFrame);
    windows.push({ startFrame, frames });
    if (startFrame + frames >= requestedFrames) break;
  }
  return windows;
}

/**
 * Keep the normal bounded reset cadence, but move a reset onto a real audio
 * pause when one occurs before the next native-window deadline. Such windows
 * restart from the original avatar; deadline-only windows keep the clean
 * handoff used by the existing stabilized workflow.
 */
export function planWanS2VSilenceWindows(
  durationSeconds: number,
  silences: WanSilenceInterval[],
  stabilizationSeconds = WAN_S2V_STABILIZATION_SECONDS
): WanVideoWindow[] {
  const requestedFrames = Math.max(1, Math.ceil(durationSeconds * WAN_S2V_FPS));
  const intervalFrames = parseWanStabilizationSeconds(stabilizationSeconds) * WAN_S2V_FPS;
  const minGapFrames = WAN_S2V_FPS; // Avoid tiny renders from consecutive short pauses.
  const minTailFrames = minGapFrames + WAN_S2V_OVERLAP_FRAMES;
  const candidates = silences
    .filter(silence => silence.duration >= 0.20 && silence.start > 0.20 && silence.end < durationSeconds - 0.20)
    .map(silence => ({
      frame: Math.round(((silence.start + silence.end) / 2) * WAN_S2V_FPS),
      silence
    }))
    .filter(candidate => candidate.frame >= minGapFrames && candidate.frame <= requestedFrames - minTailFrames)
    .sort((a, b) => a.frame - b.frame);

  const starts: Array<{ frame: number; resetToOriginal: boolean; silence?: WanSilenceInterval }> = [
    { frame: 0, resetToOriginal: true }
  ];
  let startFrame = 0;
  while (true) {
    const deadline = startFrame + intervalFrames;
    const lastUsefulStart = requestedFrames - minTailFrames;
    const eligible = candidates.filter(candidate =>
      candidate.frame >= startFrame + minGapFrames && candidate.frame <= Math.min(deadline, lastUsefulStart)
    );
    const silence = eligible.at(-1);
    if (!silence && deadline >= requestedFrames - WAN_S2V_OVERLAP_FRAMES) break;
    const nextFrame = silence?.frame ?? deadline;
    if (nextFrame <= startFrame) break;
    starts.push({ frame: nextFrame, resetToOriginal: Boolean(silence), silence: silence?.silence });
    startFrame = nextFrame;
  }

  return starts.map((start, index) => {
    const next = starts[index + 1];
    const frames = next
      ? next.frame - start.frame + WAN_S2V_OVERLAP_FRAMES
      : requestedFrames - start.frame;
    return {
      startFrame: start.frame,
      frames: Math.min(frames, requestedFrames - start.frame),
      resetToOriginal: start.resetToOriginal,
      ...(start.silence ? { silence: start.silence } : {})
    };
  });
}

export const WAN_S2V_NODES = [
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "AudioEncoderLoader",
  "AudioEncoderEncode",
  "LoadAudio",
  "LoadImage",
  "CLIPTextEncode",
  "WanSoundImageToVideo",
  "WanSoundImageToVideoExtend",
  "ModelSamplingSD3",
  "KSampler",
  "LatentConcat",
  "VAEDecode",
  "CreateVideo",
  "SaveVideo"
] as const;

const WAN_S2V_FP8_MODEL = "wan2.2_s2v_14B_fp8_scaled.safetensors";
const WAN_S2V_BF16_MODEL = "wan2.2_s2v_14B_bf16.safetensors";
const configuredDiffusionModel = process.env.WAN_S2V_DIFFUSION_MODEL?.trim();

export const WAN_S2V_MODELS = {
  // BF16 is the quality-first default; retain FP8 as an easy environment-based
  // fallback for machines prioritizing lower memory use or faster loading.
  diffusion: configuredDiffusionModel === WAN_S2V_FP8_MODEL ? WAN_S2V_FP8_MODEL : WAN_S2V_BF16_MODEL,
  textEncoder: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  audioEncoder: "wav2vec2_large_english_fp16.safetensors",
  vae: "wan_2.1_vae.safetensors"
} as const;

/** Keep prompts independent of the subject's species and materials. */
export function wanS2VPrompt(strictIdentity: boolean, motionPrompt = ""): string {
  if (!strictIdentity && motionPrompt.trim()) return motionPrompt.trim();
  return "The same subject from the reference image speaks with synchronized mouth movement. Preserve the exact identity, anatomy, shapes, surface materials, colors, clothing, lighting and background. Subtle natural motion, stable camera, continuous shot.";
}

/**
 * Workflow longue durée Wan2.2-S2V basé sur le mécanisme natif Extend de ComfyUI.
 *
 * Au lieu de générer plusieurs vidéos indépendantes puis de les raccorder :
 *   chunk initial -> Extend -> Extend -> ... -> décodage final unique.
 *
 * Chaque Extend reçoit le latent vidéo cumulé précédent. Le node natif utilise
 * les dernières frames du latent précédent comme référence de mouvement, ce qui
 * conserve bien mieux la continuité du visage, de la pose et du décor.
 */
export function buildWanS2VExtendedWorkflow(args: {
  imageName: string;
  audioName: string;
  prompt: string;
  strictIdentity?: boolean;
  seed: number;
  width?: number;
  height?: number;
  durationSeconds: number;
  steps?: number;
  cfg?: number;
  filenamePrefix?: string;
  chunkFrames?: number;
  stabilizationSeconds?: number;
  /** Optional visual handoff while still rebuilding the latent graph. */
  controlImageName?: string;
}): { graph: PromptGraph; chunks: number; generatedFrames: number; windows?: WanVideoWindow[] } {
  const width = args.width ?? 768;
  const height = args.height ?? 432;
  const chunkFrames = args.chunkFrames ?? WAN_S2V_CHUNK_FRAMES;
  const requestedFrames = Math.max(1, Math.ceil(args.durationSeconds * WAN_S2V_FPS));
  const chunks = Math.max(1, Math.ceil(requestedFrames / chunkFrames));
  // Wan VAE decodes 4*T-3 frames, not 77 per concatenated latent block.
  const generatedFrames = chunks * (Math.floor((chunkFrames - 1) / 4) + 1) * 4 - 3;
  const steps = args.steps ?? 20;
  const cfg = args.cfg ?? 6;

  const graph: PromptGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: WAN_S2V_MODELS.diffusion, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: WAN_S2V_MODELS.textEncoder, type: "wan", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: WAN_S2V_MODELS.vae } },
    "4": { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: WAN_S2V_MODELS.audioEncoder } },
    "5": { class_type: "LoadAudio", inputs: { audio: args.audioName } },
    "6": { class_type: "AudioEncoderEncode", inputs: { audio_encoder: ["4", 0], audio: ["5", 0] } },
    "7": { class_type: "LoadImage", inputs: { image: args.imageName } },
    "8": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: args.prompt } },
    "9": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: args.strictIdentity
          ? "identity change, different person, different face, face morphing, facial drift, changed facial proportions, changed eyes, changed nose, changed jaw, red lips, pink lips, lipstick, lip color change, red mouth glow, solid red mouth, oversaturated mouth, painted mouth, flat color patch, color blob, waxy skin, plastic skin, loss of skin texture, oversmoothed face, distorted mouth, deformed face, duplicate face, extra limbs, subtitles, text, watermark, low quality, blurry"
          : "static image, frozen face, bad lip sync, distorted mouth, deformed face, duplicate face, extra limbs, subtitles, text, watermark, low quality, blurry"
      }
    },
    "10": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "11": {
      class_type: "WanSoundImageToVideo",
      inputs: {
        positive: ["8", 0],
        negative: ["9", 0],
        vae: ["3", 0],
        width,
        height,
        length: chunkFrames,
        // batch_size compte les vidéos indépendantes, pas les blocs temporels.
        // Extend conserve cette dimension : une seule vidéo suffit, les blocs
        // suivants sont ajoutés sur l'axe temporel par LatentConcat.
        batch_size: 1,
        audio_encoder_output: ["6", 0],
        // The official image + audio workflow uses ref_image only. control_video
        // is an additional conditioning branch, not a first-frame pixel lock.
        ref_image: ["7", 0]
      }
    },
    "12": {
      class_type: "KSampler",
      inputs: {
        model: ["10", 0],
        positive: ["11", 0],
        negative: ["11", 1],
        latent_image: ["11", 2],
        seed: args.seed,
        steps,
        cfg,
        sampler_name: "uni_pc",
        scheduler: "simple",
        denoise: 1
      }
    }
  };

  if (args.controlImageName) {
    graph["13"] = { class_type: "LoadImage", inputs: { image: args.controlImageName } };
    graph["11"].inputs.control_video = ["13", 0];
  }

  // Le latent cumulé commence avec le premier chunk échantillonné.
  let fullLatentNode = "12";
  let nextNodeId = 20;

  for (let i = 1; i < chunks; i += 1) {
    const extendId = String(nextNodeId++);
    const samplerId = String(nextNodeId++);
    const concatId = String(nextNodeId++);

    graph[extendId] = {
      class_type: "WanSoundImageToVideoExtend",
      inputs: {
        positive: ["8", 0],
        negative: ["9", 0],
        vae: ["3", 0],
        length: chunkFrames,
        video_latent: [fullLatentNode, 0],
        audio_encoder_output: ["6", 0],
        ref_image: ["7", 0]
      }
    };

    graph[samplerId] = {
      class_type: "KSampler",
      inputs: {
        model: ["10", 0],
        positive: [extendId, 0],
        negative: [extendId, 1],
        latent_image: [extendId, 2],
        // Même seed pour garder un comportement aussi stable que possible.
        seed: args.seed,
        steps,
        cfg,
        sampler_name: "uni_pc",
        scheduler: "simple",
        denoise: 1
      }
    };

    graph[concatId] = {
      class_type: "LatentConcat",
      inputs: {
        samples1: [fullLatentNode, 0],
        samples2: [samplerId, 0],
        dim: "t"
      }
    };

    fullLatentNode = concatId;
  }

  const decodeId = String(nextNodeId++);
  const videoId = String(nextNodeId++);
  const saveId = String(nextNodeId++);

  graph[decodeId] = { class_type: "VAEDecode", inputs: { samples: [fullLatentNode, 0], vae: ["3", 0] } };
  graph[videoId] = { class_type: "CreateVideo", inputs: { images: [decodeId, 0], fps: WAN_S2V_FPS, audio: ["5", 0] } };
  graph[saveId] = {
    class_type: "SaveVideo",
    inputs: {
      video: [videoId, 0],
      filename_prefix: args.filenamePrefix ?? "dgx-avatar/wan-s2v-extended",
      format: "mp4",
      codec: "h264"
    }
  };

  return { graph, chunks, generatedFrames };
}

/**
 * Experimental step 1: refresh only the motion context through the VAE.
 * Sampling settings, audio offsets and the accumulated output latent stay the
 * same as native Extend. The context proxy has the same temporal length so the
 * native node still selects the correct interval of the complete WAV.
 *
 * VAE-decoded images are never compressed or mixed with the source image. The
 * proxy is used only by Extend; final concatenation keeps the original samples.
 */
export function buildWanS2VReencodedMotionWorkflow(
  args: Parameters<typeof buildWanS2VExtendedWorkflow>[0]
): ReturnType<typeof buildWanS2VExtendedWorkflow> {
  const chunkFrames = args.chunkFrames ?? WAN_S2V_CHUNK_FRAMES;
  if (chunkFrames !== WAN_S2V_CHUNK_FRAMES) {
    throw new RangeError("Le test de contexte réencodé utilise les blocs natifs de 77 images.");
  }
  const result = buildWanS2VExtendedWorkflow(args);
  const graph = result.graph;
  const extensions = Object.values(graph).filter(node => node.class_type === "WanSoundImageToVideoExtend");
  let nextId = Math.max(...Object.keys(graph).map(Number)) + 1;
  for (const [index, extension] of extensions.entries()) {
    const history = extension.inputs.video_latent as [string, number];
    const latentFrames = (index + 1) * 20;
    const decodedFrames = latentFrames * 4 - 3;
    const decodeId = String(nextId++);
    const cropId = String(nextId++);
    const encodeId = String(nextId++);
    const prefixId = String(nextId++);
    const proxyId = String(nextId++);
    graph[decodeId] = { class_type: "VAEDecode", inputs: { samples: history, vae: ["3", 0] } };
    graph[cropId] = {
      class_type: "ImageFromBatch",
      inputs: { image: [decodeId, 0], batch_index: decodedFrames - WAN_S2V_MOTION_FRAMES, length: WAN_S2V_MOTION_FRAMES }
    };
    graph[encodeId] = { class_type: "VAEEncode", inputs: { pixels: [cropId, 0], vae: ["3", 0] } };
    graph[prefixId] = {
      class_type: "LatentCut", inputs: { samples: history, dim: "t", index: 0, amount: latentFrames - 19 }
    };
    graph[proxyId] = {
      class_type: "LatentConcat", inputs: { samples1: [prefixId, 0], samples2: [encodeId, 0], dim: "t" }
    };
    extension.inputs.video_latent = [proxyId, 0];
  }
  return result;
}

/** Camera/framing instruction used by the UI-validated long-form recipe. */
export const WAN_S2V_FIXED_FRAMING_PROMPT =
  "Fixed locked camera for the entire clip, at exactly the same distance and angle as the reference image. Preserve the same head-and-shoulders crop, screen position, and subject size from the first frame to the last. No zoom in or zoom out, no dolly, no pan, no tilt, no camera movement, no reframing. Only the subject's face and mouth move subtly while speaking.";

/** Production recipe validated for long-form Extend: refreshed motion context,
 * progressive sampler seeds, and a fixed-camera prompt. */
export function buildWanS2VFixedFramingWorkflow(
  args: Parameters<typeof buildWanS2VExtendedWorkflow>[0]
): ReturnType<typeof buildWanS2VExtendedWorkflow> {
  const prompt = `${args.prompt.trim()} ${WAN_S2V_FIXED_FRAMING_PROMPT}`;
  const result = buildWanS2VReencodedMotionWorkflow({ ...args, prompt });
  const samplers = Object.entries(result.graph)
    .filter(([, node]) => node.class_type === "KSampler")
    .sort(([a], [b]) => Number(a) - Number(b));
  samplers.forEach(([, node], index) => { node.inputs.seed = args.seed + index; });
  return result;
}

/**
 * Réinitialise l'historique latent au délai choisi. Le premier bloc part de
 * l'image source exacte. Chaque bloc suivant reçoit directement la dernière
 * image générée juste avant son instant de départ comme référence de mouvement.
 * L'avatar original reste en parallèle la référence d'identité (`ref_image`) de
 * TOUS les conditionnements. Les chevauchements sont fusionnés à la finalisation.
 */
function buildWanS2VWindowedWorkflow(
  args: Parameters<typeof buildWanS2VExtendedWorkflow>[0],
  windows: WanVideoWindow[]
): ReturnType<typeof buildWanS2VExtendedWorkflow> {
  if (windows.length === 1) return buildWanS2VExtendedWorkflow(args);

  const graph: PromptGraph = {};
  // Poids, prompts, image originale et WAV complet partagés entre les fenêtres.
  const sharedIds = new Set(["1", "2", "3", "4", "5", "7", "8", "9", "10"]);
  let nextNodeId = 20;
  let fullImages: string | undefined;
  let previousMotion: string | undefined;
  let previousAnchor: string | undefined;
  let chunks = 0;
  let generatedFrames = 0;

  for (const [windowIndex, { startFrame, frames }] of windows.entries()) {
    const durationSeconds = frames / WAN_S2V_FPS;
    const part = buildWanS2VExtendedWorkflow({ ...args, durationSeconds });
    chunks += part.chunks;
    generatedFrames += part.generatedFrames;

    const trimId = String(nextNodeId++);
    graph[trimId] = {
      class_type: "TrimAudioDuration",
      inputs: { audio: ["5", 0], start_index: startFrame / WAN_S2V_FPS, duration: durationSeconds }
    };
    const nodes = Object.entries(part.graph).filter(([, node]) =>
      node.class_type !== "CreateVideo" && node.class_type !== "SaveVideo"
    );
    const ids = new Map(nodes.map(([id]) => [id, sharedIds.has(id) ? id : String(nextNodeId++)]));
    let decodedId = "";
    for (const [id, node] of nodes) {
      const mappedId = ids.get(id)!;
      if (sharedIds.has(id) && graph[mappedId]) continue;
      const inputs = Object.fromEntries(Object.entries(node.inputs).map(([key, value]) => [
        key, Array.isArray(value) ? [ids.get(String(value[0]))!, value[1]] : value
      ]));
      if (node.class_type === "AudioEncoderEncode") inputs.audio = [trimId, 0];
      if (node.class_type === "WanSoundImageToVideo" && previousMotion && !windows[windowIndex].resetToOriginal) {
        inputs.ref_motion = [previousMotion, 0];
        // `ref_motion` et `control_video` reçoivent la même ancre propre. La
        // dernière image précédente ne fournit que sa pose : aucun de ses
        // pixels générés n'est réinjecté dans la nouvelle fenêtre.
        inputs.control_video = [previousAnchor!, 0];
      }
      graph[mappedId] = { class_type: node.class_type, inputs };
      if (node.class_type === "VAEDecode") decodedId = mappedId;
    }

    // Le VAE temporel peut produire quelques frames de plus que le compte
    // nominal. Chaque fenêtre doit contenir exactement le nombre de frames prévu.
    const cropId = String(nextNodeId++);
    graph[cropId] = {
      class_type: "ImageFromBatch",
      inputs: { image: [decodedId, 0], batch_index: 0, length: frames }
    };

    const nextWindow = windows[windowIndex + 1];
    if (nextWindow && !nextWindow.resetToOriginal) {
      // Le bloc suivant rejoue le chevauchement. Sa pose précédente est donc
      // l'image juste AVANT cette zone, pas la fin du décodage (dans son futur),
      // ni les frames supplémentaires produites par le VAE temporel.
      const lastFrameId = String(nextNodeId++);
      graph[lastFrameId] = {
        class_type: "ImageFromBatch",
        inputs: { image: [cropId, 0], batch_index: nextWindow.startFrame - startFrame - 1, length: 1 }
      };
      const preparedId = String(nextNodeId++);
      graph[preparedId] = {
        class_type: "DGXPrepareWanHandoff",
        // La sortie 0 maintient l'ancre propre pendant les 9 images de contrôle
        // (le raccord et sa première image unique). La sortie 1 est cette même
        // ancre, répétée ensuite comme historique de mouvement.
        inputs: { image: [lastFrameId, 0], original: ["7", 0] }
      };
      const motionId = String(nextNodeId++);
      graph[motionId] = {
        class_type: "RepeatImageBatch",
        // Ne plus répéter la frame générée dégradée : l'ancre reconstruite avec
        // les pixels originaux évite la boucle lèvres rouges / perte de texture.
        inputs: { image: [preparedId, 1], amount: WAN_S2V_MOTION_FRAMES }
      };
      previousMotion = motionId;
      previousAnchor = preparedId;
    }
    if (fullImages) {
      const concatId = String(nextNodeId++);
      graph[concatId] = { class_type: "ImageBatch", inputs: { image1: [fullImages, 0], image2: [cropId, 0] } };
      fullImages = concatId;
    } else fullImages = cropId;
  }

  const videoId = String(nextNodeId++);
  graph[videoId] = {
    class_type: "CreateVideo",
    // Le fichier intermédiaire n'a pas de piste audio : les chevauchements
    // allongent sa durée. Le WAV original est ajouté après leur fusion.
    inputs: { images: [fullImages!, 0], fps: WAN_S2V_FPS }
  };
  graph[String(nextNodeId++)] = {
    class_type: "SaveVideo",
    inputs: {
      video: [videoId, 0], filename_prefix: args.filenamePrefix ?? "dgx-avatar/wan-s2v-stable",
      format: "mp4", codec: "h264"
    }
  };
  return { graph, chunks, generatedFrames, windows };
}

export function buildWanS2VStabilizedWorkflow(
  args: Parameters<typeof buildWanS2VExtendedWorkflow>[0]
): ReturnType<typeof buildWanS2VExtendedWorkflow> {
  return buildWanS2VWindowedWorkflow(args, planWanS2VWindows(args.durationSeconds, args.stabilizationSeconds));
}

export function buildWanS2VSilenceAwareWorkflow(
  args: Parameters<typeof buildWanS2VExtendedWorkflow>[0],
  silences: WanSilenceInterval[]
): ReturnType<typeof buildWanS2VExtendedWorkflow> {
  return buildWanS2VWindowedWorkflow(
    args,
    planWanS2VSilenceWindows(args.durationSeconds, silences, args.stabilizationSeconds)
  );
}
