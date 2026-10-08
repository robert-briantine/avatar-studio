import type { PromptGraph } from "./workflows.js";

// Generate more intermediate poses while keeping the narration's pause length.
export const WAN_FLF_FPS = 48;

export const WAN_FLF_NODES = [
  "UNETLoader", "CLIPLoader", "VAELoader", "LoadImage", "CLIPTextEncode",
  "WanFirstLastFrameToVideo", "ModelSamplingSD3", "KSamplerAdvanced",
  "VAEDecode", "CreateVideo", "SaveVideo"
] as const;

export const WAN_FLF_MODELS = {
  high: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
  low: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
  textEncoder: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "wan_2.1_vae.safetensors"
} as const;

export function buildWanFirstLastFrameWorkflow(args: {
  startImageName: string;
  endImageName: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  durationSeconds: number;
  seed: number;
  steps?: number;
  filenamePrefix?: string;
}): { graph: PromptGraph; frames: number } {
  // Wan's temporal VAE decodes 4n+1 frames. Other lengths can discard the
  // end-image conditioning. The complete clip is retimed during assembly.
  const frames = Math.max(9, Math.ceil((Math.round(args.durationSeconds * WAN_FLF_FPS) - 1) / 4) * 4 + 1);
  const steps = Math.max(4, Math.min(30, args.steps ?? 20));
  const graph: PromptGraph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: WAN_FLF_MODELS.high, weight_dtype: "default" } },
    "2": { class_type: "UNETLoader", inputs: { unet_name: WAN_FLF_MODELS.low, weight_dtype: "default" } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: WAN_FLF_MODELS.textEncoder, type: "wan", device: "default" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: WAN_FLF_MODELS.vae } },
    "5": { class_type: "LoadImage", inputs: { image: args.startImageName } },
    "6": { class_type: "LoadImage", inputs: { image: args.endImageName } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: args.prompt } },
    "8": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: args.negativePrompt || "static image, flicker, exposure change, lighting change, crushed shadows, oversaturated colors, distorted face, deformed mouth, extra limbs, blurry, low quality, text, watermark" } },
    "9": {
      class_type: "WanFirstLastFrameToVideo",
      inputs: {
        positive: ["7", 0], negative: ["8", 0], vae: ["4", 0],
        width: args.width, height: args.height, length: frames, batch_size: 1,
        start_image: ["5", 0], end_image: ["6", 0]
      }
    },
    "10": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "11": { class_type: "KSamplerAdvanced", inputs: {
      model: ["10", 0], positive: ["9", 0], negative: ["9", 1], latent_image: ["9", 2],
      add_noise: "enable", noise_seed: args.seed,
      steps, cfg: 4, sampler_name: "euler", scheduler: "simple", start_at_step: 0,
      end_at_step: Math.max(1, Math.floor(steps / 2)), return_with_leftover_noise: "enable"
    } },
    "12": { class_type: "ModelSamplingSD3", inputs: { model: ["2", 0], shift: 8 } },
    "13": { class_type: "KSamplerAdvanced", inputs: {
      model: ["12", 0], positive: ["9", 0], negative: ["9", 1], latent_image: ["11", 0],
      add_noise: "disable", noise_seed: args.seed,
      steps, cfg: 4, sampler_name: "euler", scheduler: "simple", start_at_step: Math.max(1, Math.floor(steps / 2)),
      end_at_step: 10000, return_with_leftover_noise: "disable"
    } },
    "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["4", 0] } },
    "15": { class_type: "CreateVideo", inputs: { images: ["14", 0], fps: WAN_FLF_FPS } },
    "16": { class_type: "SaveVideo", inputs: { video: ["15", 0], filename_prefix: args.filenamePrefix || "dgx-avatar/wan-flf", format: "auto", codec: "auto" } }
  };
  return { graph, frames };
}
