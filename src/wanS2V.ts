import type { PromptGraph } from "./workflows.js";

export const WAN_S2V_CHUNK_FRAMES = 77;
export const WAN_S2V_FPS = 16;
export const WAN_S2V_STABILIZATION_SECONDS = 20;
export const WAN_S2V_OVERLAP_FRAMES = 8; // 0,5 s : mêmes instants audio dans les deux fenêtres.
export const WAN_S2V_MOTION_FRAMES = 73; // Contexte ref_motion attendu par le nœud natif Wan S2V.
export const WAN_S2V_STABLE_NODES = [
  "TrimAudioDuration", "ImageFromBatch", "ImageBatch", "RepeatImageBatch", "DGXRestoreWanReference"
] as const;
export type WanVideoWindow = { startFrame: number; frames: number };

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
  // Le chevauchement vient APRÈS le délai choisi : 20 s signifie une reprise
  // à 20 s (image 320), depuis l'image 319, puis à 40 s, 60 s, etc.
  const windowFrames = intervalFrames + WAN_S2V_OVERLAP_FRAMES;
  const windows: WanVideoWindow[] = [];
  for (let startFrame = 0; startFrame < requestedFrames; startFrame += intervalFrames) {
    const frames = Math.min(windowFrames, requestedFrames - startFrame);
    windows.push({ startFrame, frames });
    if (startFrame + frames >= requestedFrames) break;
  }
  return windows;
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

export const WAN_S2V_MODELS = {
  diffusion: "wan2.2_s2v_14B_fp8_scaled.safetensors",
  textEncoder: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  audioEncoder: "wav2vec2_large_english_fp16.safetensors",
  vae: "wan_2.1_vae.safetensors"
} as const;

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
}): { graph: PromptGraph; chunks: number; generatedFrames: number; windows?: WanVideoWindow[] } {
  const width = args.width ?? 768;
  const height = args.height ?? 432;
  const chunkFrames = args.chunkFrames ?? WAN_S2V_CHUNK_FRAMES;
  const requestedFrames = Math.max(1, Math.ceil(args.durationSeconds * WAN_S2V_FPS));
  const chunks = Math.max(1, Math.ceil(requestedFrames / chunkFrames));
  const generatedFrames = chunks * chunkFrames;
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
          ? "identity change, different person, different face, face morphing, facial drift, changed facial proportions, changed eyes, changed nose, changed jaw, distorted mouth, deformed face, duplicate face, extra limbs, subtitles, text, watermark, low quality, blurry"
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
 * Réinitialise l'historique latent au délai choisi. La dernière image avant la
 * reprise sert à estimer la pose, puis cette pose est reconstruite avec les
 * pixels de l'avatar original avant d'être transmise comme référence de mouvement.
 * L'avatar original reste la référence d'identité de TOUS les conditionnements :
 * remplacer ref_image par l'image générée propagerait sa perte de détails.
 * Les chevauchements sont fusionnés à la finalisation.
 */
export function buildWanS2VStabilizedWorkflow(
  args: Parameters<typeof buildWanS2VExtendedWorkflow>[0]
): ReturnType<typeof buildWanS2VExtendedWorkflow> {
  const windows = planWanS2VWindows(args.durationSeconds, args.stabilizationSeconds);
  if (windows.length === 1) return buildWanS2VExtendedWorkflow(args);

  const graph: PromptGraph = {};
  // Poids, prompts, image originale et WAV complet partagés entre les fenêtres.
  const sharedIds = new Set(["1", "2", "3", "4", "5", "7", "8", "9", "10"]);
  let nextNodeId = 20;
  let fullImages: string | undefined;
  let previousMotion: string | undefined;
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
      if (node.class_type === "WanSoundImageToVideo" && previousMotion) {
        inputs.ref_motion = [previousMotion, 0];
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
    if (nextWindow) {
      // Le bloc suivant rejoue le chevauchement. Sa pose précédente est donc
      // l'image juste AVANT cette zone, pas la fin du décodage (dans son futur),
      // ni les frames supplémentaires produites par le VAE temporel.
      const lastFrameId = String(nextNodeId++);
      graph[lastFrameId] = {
        class_type: "ImageFromBatch",
        inputs: { image: [cropId, 0], batch_index: nextWindow.startFrame - startFrame - 1, length: 1 }
      };
      const restoreId = String(nextNodeId++);
      graph[restoreId] = {
        class_type: "DGXRestoreWanReference",
        // La frame générée fournit uniquement la pose. Les pixels viennent
        // toujours de l'avatar original intact, jamais d'une reprise précédente.
        inputs: { image: [lastFrameId, 0], original: ["7", 0] }
      };
      const motionId = String(nextNodeId++);
      graph[motionId] = {
        class_type: "RepeatImageBatch",
        // Avec une seule image, Wan complète ref_motion par 72 images grises
        // avant l'encodage temporel. Répéter la pose évite ce faux historique
        // et ses artefacts, sans réintroduire les mouvements des anciens blocs.
        inputs: { image: [restoreId, 0], amount: WAN_S2V_MOTION_FRAMES }
      };
      previousMotion = motionId;
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
