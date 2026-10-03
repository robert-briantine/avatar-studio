#!/usr/bin/env bash
set -euo pipefail
URL="${COMFY_URL:-http://127.0.0.1:8188}"
python3 - "$URL" <<'PY'
import json, sys, urllib.request
url=sys.argv[1].rstrip('/')+'/object_info'
try:
    info=json.load(urllib.request.urlopen(url, timeout=5))
except Exception as e:
    print('ComfyUI inaccessible:', e); raise SystemExit(2)
required=['AudioEncoderLoader','AudioEncoderEncode','WanSoundImageToVideo','WanSoundImageToVideoExtend','LatentConcat','ModelSamplingSD3','CreateVideo','SaveVideo']
missing=[x for x in required if x not in info]
print('Nodes Wan2.2-S2V:', 'OK' if not missing else 'MANQUANTS: '+', '.join(missing))
def node_has(node, name):
    try:
        return name in json.dumps(info.get(node, {}), ensure_ascii=False)
    except Exception:
        return False
models=[
 ('UNETLoader','wan2.2_s2v_14B_fp8_scaled.safetensors'),
 ('CLIPLoader','umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
 ('AudioEncoderLoader','wav2vec2_large_english_fp16.safetensors'),
 ('VAELoader','wan_2.1_vae.safetensors')]
mm=[name for node,name in models if not node_has(node,name)]
print('Modèles Wan2.2-S2V:', 'OK' if not mm else 'MANQUANTS: '+', '.join(mm))
raise SystemExit(1 if missing or mm else 0)
PY
