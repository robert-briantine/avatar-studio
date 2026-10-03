#!/usr/bin/env bash
set -euo pipefail
COMFY_DIR="${COMFY_DIR:-/home/blockapicoder/comfyui-spark/ComfyUI}"
mkdir -p "$COMFY_DIR/models/diffusion_models" "$COMFY_DIR/models/text_encoders" "$COMFY_DIR/models/audio_encoders" "$COMFY_DIR/models/vae"
fetch(){ url="$1"; dest="$2"; if [ -s "$dest" ]; then echo "Déjà présent: $dest"; else echo "Téléchargement: $dest"; wget -c --show-progress -O "$dest" "$url"; fi; }
BASE="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files"
fetch "$BASE/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors" "$COMFY_DIR/models/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors"
fetch "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" "$COMFY_DIR/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
fetch "$BASE/audio_encoders/wav2vec2_large_english_fp16.safetensors" "$COMFY_DIR/models/audio_encoders/wav2vec2_large_english_fp16.safetensors"
fetch "$BASE/vae/wan_2.1_vae.safetensors" "$COMFY_DIR/models/vae/wan_2.1_vae.safetensors"
echo "Modèles installés. Redémarre ComfyUI puis lance ./check-wan-s2v.sh"
