import fs from "node:fs";
import path from "node:path";

function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Les variables déjà définies par le shell gardent la priorité.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function envString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  comfyUrl: envString("COMFY_URL", "http://127.0.0.1:8188").replace(/\/$/, ""),
  ttsUrl: envString("TTS_URL", "http://127.0.0.1:8880").replace(/\/$/, ""),
  models: {
    baseBf16: envString("QWEN_BASE_MODEL_BF16", "qwen_image_2512_bf16.safetensors"),
    editBf16: envString("QWEN_EDIT_MODEL_BF16", "qwen_image_edit_2511_bf16.safetensors"),
    clip: envString("QWEN_TEXT_ENCODER", "qwen_2.5_vl_7b.safetensors"),
    vae: envString("QWEN_VAE", "qwen_image_vae.safetensors")
  },
  generation: {
    baseSteps: Number(process.env.BASE_STEPS ?? 50),
    baseCfg: Number(process.env.BASE_CFG ?? 4),
    editSteps: Number(process.env.EDIT_STEPS ?? 20),
    editCfg: Number(process.env.EDIT_CFG ?? 4)
  },
  hunyuan3d: {
    url: envString("HUNYUAN3D_URL", "http://127.0.0.1:8081").replace(/\/$/, ""),
    dir: envString("HUNYUAN3D_DIR", "/home/blockapicoder/Hunyuan3D-2"),
    modelPath: envString("HUNYUAN3D_MODEL_PATH", "tencent/Hunyuan3D-2mini"),
    timeoutMs: Number(process.env.HUNYUAN3D_TIMEOUT_MS ?? 1800000)
  },
  tts: {
    model: envString("TTS_MODEL", "tts-1-hd-fr"),
    language: envString("TTS_LANGUAGE", "French"),
    apiKey: envString("TTS_API_KEY", "sk-dummy-key"),
    timeoutMs: Number(process.env.TTS_TIMEOUT_MS ?? 600000)
  },

  video: {
    transitionPython: envString("WAN_TRANSITION_PYTHON", envString("COMFY_PY", "/home/blockapicoder/comfyui-spark/comfyui-env/bin/python")),
    // ComfyUI gère l'éviction des modèles selon la mémoire disponible.
    // Option de repli pour retrouver le déchargement systématique historique.
    freeMemoryBeforeWan: /^(1|true|yes)$/i.test(envString("WAN_FREE_MEMORY_BEFORE_VIDEO", "false")),
    width: Number(process.env.VIDEO_WIDTH ?? 1920),
    height: Number(process.env.VIDEO_HEIGHT ?? 1080),
    fps: Number(process.env.VIDEO_FPS ?? 30),
    silentSeconds: Number(process.env.SILENT_SEGMENT_SECONDS ?? 2)
  }
};
