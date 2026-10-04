#!/usr/bin/env bash
set -euo pipefail

mode="${1:-all}"
case "$mode" in
  all|hybrid|longcat) ;;
  *) echo "Usage: $0 [all|hybrid|longcat]" >&2; exit 2 ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_root="$(cd -- "$script_dir/../.." && pwd)"
engines_root="${DGX_VIDEO_ENGINES_ROOT:-/home/blockapicoder/dgx-avatar-engines}"
src_root="$engines_root/src"
mkdir -p "$src_root" "$engines_root/cache" "$engines_root/models"

clone_if_missing() {
  local url="$1" target="$2"
  if [[ ! -d "$target/.git" ]]; then
    git clone --depth 1 "$url" "$target"
  fi
}

clone_if_missing https://github.com/KlingAIResearch/LivePortrait "$src_root/LivePortrait"
clone_if_missing https://github.com/TMElyralab/MuseTalk "$src_root/MuseTalk"
clone_if_missing https://github.com/meituan-longcat/LongCat-Video "$src_root/LongCat-Video"

uid="$(id -u)"
gid="$(id -g)"

download_hybrid() {
  docker build -t dgx-avatar-hybrid:local -f "$script_dir/Dockerfile.hybrid" "$app_root"
  docker run --rm --user "$uid:$gid" \
    -e HOME=/tmp/dgx-avatar-home -e HF_HOME=/engines/cache/huggingface -e HF_HUB_DOWNLOAD_TIMEOUT=600 \
    -v "$engines_root:/engines" dgx-avatar-hybrid:local \
    huggingface-cli download KlingTeam/LivePortrait --local-dir /engines/src/LivePortrait/pretrained_weights \
      --max-workers 2 --exclude '*.git*' README.md 'docs/*'
  docker run --rm --user "$uid:$gid" \
    -e HOME=/tmp/dgx-avatar-home -e HF_HOME=/engines/cache/huggingface -e HF_HUB_DOWNLOAD_TIMEOUT=600 \
    -v "$engines_root:/engines" dgx-avatar-hybrid:local \
    huggingface-cli download TMElyralab/MuseTalk --local-dir /engines/src/MuseTalk/models \
      --max-workers 1 --include musetalkV15/musetalk.json musetalkV15/unet.pth
  docker run --rm --user "$uid:$gid" \
    -e HOME=/tmp/dgx-avatar-home -e HF_HOME=/engines/cache/huggingface -e HF_HUB_DOWNLOAD_TIMEOUT=600 \
    -v "$engines_root:/engines" dgx-avatar-hybrid:local \
    huggingface-cli download stabilityai/sd-vae-ft-mse --local-dir /engines/src/MuseTalk/models/sd-vae \
      --max-workers 1 --include config.json diffusion_pytorch_model.bin
  docker run --rm --user "$uid:$gid" \
    -e HOME=/tmp/dgx-avatar-home -e HF_HOME=/engines/cache/huggingface -e HF_HUB_DOWNLOAD_TIMEOUT=600 \
    -v "$engines_root:/engines" dgx-avatar-hybrid:local \
    huggingface-cli download openai/whisper-tiny --local-dir /engines/src/MuseTalk/models/whisper \
      --max-workers 1 --include config.json pytorch_model.bin preprocessor_config.json
  docker run --rm --user "$uid:$gid" \
    -e HOME=/tmp/dgx-avatar-home -e HF_HOME=/engines/cache/huggingface -e HF_HUB_DOWNLOAD_TIMEOUT=600 \
    -v "$engines_root:/engines" dgx-avatar-hybrid:local \
    huggingface-cli download yzd-v/DWPose --local-dir /engines/src/MuseTalk/models/dwpose \
      --max-workers 1 --include dw-ll_ucoco_384.pth
  docker run --rm --user "$uid:$gid" \
    -e HOME=/tmp/dgx-avatar-home -v "$engines_root:/engines" dgx-avatar-hybrid:local \
    bash -lc 'mkdir -p /engines/src/MuseTalk/models/face-parse-bisent && \
      gdown --id 154JgKpzCPW82qINcVieuPH3fZ2e0P812 -O /engines/src/MuseTalk/models/face-parse-bisent/79999_iter.pth && \
      curl -L --fail --retry 3 https://download.pytorch.org/models/resnet18-5c106cde.pth \
        -o /engines/src/MuseTalk/models/face-parse-bisent/resnet18-5c106cde.pth'
}

download_longcat() {
  docker build -t dgx-avatar-longcat:local -f "$script_dir/Dockerfile.longcat" "$app_root"
  docker run --rm --user "$uid:$gid" \
    -e HOME=/tmp/dgx-avatar-home -e HF_HOME=/engines/cache/huggingface -e HF_HUB_DOWNLOAD_TIMEOUT=600 \
    -v "$engines_root:/engines" dgx-avatar-longcat:local \
    huggingface-cli download meituan-longcat/LongCat-Video \
      --local-dir /engines/src/LongCat-Video/weights/LongCat-Video --max-workers 2 \
      --include 'tokenizer/*' 'text_encoder/*' 'vae/*'
  docker run --rm --user "$uid:$gid" \
    -e HOME=/tmp/dgx-avatar-home -e HF_HOME=/engines/cache/huggingface -e HF_HUB_DOWNLOAD_TIMEOUT=600 \
    -v "$engines_root:/engines" dgx-avatar-longcat:local \
    huggingface-cli download meituan-longcat/LongCat-Video-Avatar-1.5 \
      --local-dir /engines/src/LongCat-Video/weights/LongCat-Video-Avatar-1.5 --max-workers 2 \
      --include 'base_model_int8/*' 'lora/dmd_lora.safetensors' 'scheduler/*' \
        'whisper-large-v3/config.json' 'whisper-large-v3/model.safetensors' \
        'whisper-large-v3/preprocessor_config.json' 'vocal_separator/Kim_Vocal_2.onnx'
}

if [[ "$mode" == all || "$mode" == hybrid ]]; then download_hybrid; fi
if [[ "$mode" == all || "$mode" == longcat ]]; then download_longcat; fi

echo "Moteur(s) $mode installé(s) dans $engines_root"
