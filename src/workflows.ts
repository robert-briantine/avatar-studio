import { config } from "./config.js";

export type PromptGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;


export function namespacePromptGraph(graph: PromptGraph, namespace: string): PromptGraph {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
  const idMap = new Map(Object.keys(graph).map(id => [id, `${safe}-${id}`]));

  const rewrite = (value: unknown): unknown => {
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "number" &&
      idMap.has(value[0])
    ) {
      return [idMap.get(value[0])!, value[1]];
    }

    if (Array.isArray(value)) return value.map(rewrite);

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rewrite(v)])
      );
    }

    return value;
  };

  return Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [
      idMap.get(id)!,
      {
        class_type: node.class_type,
        inputs: rewrite(node.inputs) as Record<string, unknown>
      }
    ])
  );
}

export function buildQwen2512Workflow(args: {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  negativePrompt?: string;
  modelName?: string;
  steps?: number;
  cfg?: number;
}): PromptGraph {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: args.modelName || config.models.baseBf16,
        weight_dtype: "default"
      }
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: config.models.clip,
        type: "qwen_image",
        device: "cpu"
      }
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: config.models.vae }
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: args.prompt
      }
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: args.negativePrompt || "low quality, blurry, distorted anatomy, malformed hands, oversaturated, waxy skin, artificial-looking details, chaotic composition, unreadable or distorted text"
      }
    },
    "6": {
      class_type: "EmptySD3LatentImage",
      inputs: {
        width: args.width,
        height: args.height,
        batch_size: 1
      }
    },
    "7": {
      class_type: "ModelSamplingAuraFlow",
      inputs: {
        model: ["1", 0],
        shift: 3.1
      }
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["7", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
        seed: args.seed,
        steps: args.steps ?? 50,
        cfg: args.cfg ?? 4,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1
      }
    },
    "9": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["8", 0],
        vae: ["3", 0]
      }
    },
    "10": {
      class_type: "SaveImage",
      inputs: {
        images: ["9", 0],
        filename_prefix: "dgx-image-generator/base"
      }
    }
  };
}

export function buildQwenEdit2511Workflow(args: {
  baseImage: string;
  styleImage?: string;
  prompt: string;
  seed: number;
  steps?: number;
  cfg?: number;
}): PromptGraph {
  const positiveInputs: Record<string, unknown> = {
    clip: ["2", 0],
    vae: ["3", 0],
    image1: ["6", 0],
    prompt: args.prompt
  };
  const negativeInputs: Record<string, unknown> = {
    clip: ["2", 0],
    vae: ["3", 0],
    image1: ["6", 0],
    prompt: [
      "Preserve image 1 composition, subject identity, anatomy and geometry.",
      "Do not introduce unrelated objects, duplicate subjects, text, logos or surreal artifacts.",
      "Avoid oversmoothing, plastic textures, malformed details and excessive sharpening."
    ].join(" ")
  };

  if (args.styleImage) {
    positiveInputs.image2 = ["5", 0];
    negativeInputs.image2 = ["5", 0];
  }

  const graph: PromptGraph = {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: config.models.editBf16, weight_dtype: "default" }
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: config.models.clip, type: "qwen_image", device: "cpu" }
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: config.models.vae }
    },
    "4": {
      class_type: "LoadImage",
      inputs: { image: args.baseImage }
    },
    "6": {
      class_type: "FluxKontextImageScale",
      inputs: { image: ["4", 0] }
    },
    "7": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: positiveInputs
    },
    "8": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: negativeInputs
    },
    "9": {
      class_type: "FluxKontextMultiReferenceLatentMethod",
      inputs: { conditioning: ["7", 0], reference_latents_method: "index_timestep_zero" }
    },
    "10": {
      class_type: "FluxKontextMultiReferenceLatentMethod",
      inputs: { conditioning: ["8", 0], reference_latents_method: "index_timestep_zero" }
    },
    "11": {
      class_type: "VAEEncode",
      inputs: { pixels: ["6", 0], vae: ["3", 0] }
    },
    "12": {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: ["1", 0], shift: 3.1 }
    },
    "13": {
      class_type: "CFGNorm",
      inputs: { model: ["12", 0], strength: 1, pre_cfg: false }
    },
    "14": {
      class_type: "KSampler",
      inputs: {
        model: ["13", 0],
        positive: ["9", 0],
        negative: ["10", 0],
        latent_image: ["11", 0],
        seed: args.seed,
        steps: args.steps ?? 20,
        cfg: args.cfg ?? 4,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1
      }
    },
    "15": {
      class_type: "VAEDecode",
      inputs: { samples: ["14", 0], vae: ["3", 0] }
    },
    "16": {
      class_type: "SaveImage",
      inputs: { images: ["15", 0], filename_prefix: "dgx-image-generator/refined" }
    }
  };

  if (args.styleImage) {
    graph["5"] = { class_type: "LoadImage", inputs: { image: args.styleImage } };
  }
  return graph;
}

