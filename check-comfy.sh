#!/usr/bin/env bash
set -euo pipefail
URL="${COMFY_URL:-http://127.0.0.1:8188}"
python3 - "$URL" <<'PY'
import json, sys, urllib.request
url=sys.argv[1].rstrip('/') + '/object_info'
required=[
 'UNETLoader','CLIPLoader','VAELoader','CLIPTextEncode','EmptySD3LatentImage',
 'ModelSamplingAuraFlow','KSampler','VAEDecode','SaveImage','LoadImage',
 'FluxKontextImageScale','TextEncodeQwenImageEditPlus',
 'FluxKontextMultiReferenceLatentMethod','VAEEncode','CFGNorm'
]
with urllib.request.urlopen(url, timeout=8) as r:
    obj=json.loads(r.read().decode())
missing=[x for x in required if x not in obj]
print('ComfyUI:', url)
print('missing nodes:', missing if missing else 'none')
PY
