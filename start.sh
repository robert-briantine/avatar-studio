#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

[[ -f .env ]] || cp .env.example .env

# Charge .env sans écraser les variables déjà exportées.
env_value(){ local key="$1"; [[ -f "$APP_DIR/.env" ]] || return 0; sed -n "s/^${key}=//p" "$APP_DIR/.env" | tail -n 1 | sed 's/^"//;s/"$//'; }

COMFY_URL="${COMFY_URL:-$(env_value COMFY_URL)}"; COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
TTS_URL="${TTS_URL:-$(env_value TTS_URL)}"; TTS_URL="${TTS_URL:-http://127.0.0.1:8880}"
COMFY_DIR="${COMFY_DIR:-/home/blockapicoder/comfyui-spark/ComfyUI}"
COMFY_PY="${COMFY_PY:-/home/blockapicoder/comfyui-spark/comfyui-env/bin/python}"
COMFY_CACHE_MODE="${COMFY_CACHE_MODE:-$(env_value COMFY_CACHE_MODE)}"
COMFY_CACHE_MODE="${COMFY_CACHE_MODE:-auto}"
COMFY_CACHE_ARGS=()
case "$COMFY_CACHE_MODE" in
  auto) ;; # Cache natif ; ComfyUI récent l'ajuste à la pression mémoire.
  none) COMFY_CACHE_ARGS=(--cache-none) ;;
  *) echo "ERREUR: COMFY_CACHE_MODE doit être auto ou none"; exit 2 ;;
esac
TTS_DIR="${TTS_DIR:-/home/blockapicoder/qwen3-tts}"
TTS_OFFICIAL_DIR="${TTS_OFFICIAL_DIR:-/home/blockapicoder/qwen3-tts-official}"
COMFY_LOG=/tmp/comfyui-avatar-studio.log
TTS_LOG=/tmp/qwen3-tts-avatar-studio.log
COMFY_PID=""
TTS_PID=""

cleanup(){
  # Ne tue que les processus démarrés par CE script.
  for pid in "$TTS_PID" "$COMFY_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT INT TERM

wait_http(){
  local url="$1" pid="$2" log="$3" name="$4"
  for _ in {1..180}; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then echo "$name prêt: $url"; return 0; fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "ERREUR: $name s'est arrêté."
      tail -n 100 "$log" || true
      return 1
    fi
    sleep 1
  done
  echo "ERREUR: délai dépassé pour $name ($url)"
  tail -n 100 "$log" || true
  return 1
}

echo "=== DGX Avatar Studio ==="

# 1) ComfyUI : réutilise l'instance existante, sinon démarre l'installation du DGX.
if curl -fsS --max-time 2 "$COMFY_URL/system_stats" >/dev/null 2>&1; then
  echo "ComfyUI déjà démarré: $COMFY_URL"
else
  if [[ ! -x "$COMFY_PY" ]]; then
    echo "ERREUR: ComfyUI n'est pas actif et Python introuvable: $COMFY_PY"
    exit 2
  fi
  echo "Démarrage ComfyUI: $COMFY_DIR"
  cd "$COMFY_DIR"
  # Charge aussi la restauration de référence conservée dans ce projet.
  "$COMFY_PY" main.py --listen 127.0.0.1 --port 8188 \
    --extra-model-paths-config "$APP_DIR/comfy/extra_paths.yaml" \
    "${COMFY_CACHE_ARGS[@]}" >"$COMFY_LOG" 2>&1 &
  COMFY_PID=$!
  wait_http "$COMFY_URL/system_stats" "$COMFY_PID" "$COMFY_LOG" "ComfyUI"
fi

# 2) Qwen3-TTS : réutilise l'instance existante, sinon démarre exactement le serveur VoiceDesign de l'app d'origine.
if curl -fsS --max-time 2 "$TTS_URL/health" >/dev/null 2>&1; then
  echo "Qwen3-TTS déjà démarré: $TTS_URL"
else
  if [[ ! -x "$TTS_DIR/.venv/bin/python" ]]; then
    echo "ERREUR: TTS n'est pas actif et environnement introuvable: $TTS_DIR/.venv/bin/python"
    exit 3
  fi
  if [[ -d "$TTS_OFFICIAL_DIR/qwen_tts" ]]; then
    QWEN_PYTHONPATH="$TTS_OFFICIAL_DIR"
  else
    QWEN_PYTHONPATH=""
  fi
  echo "Démarrage Qwen3-TTS VoiceDesign"
  cd "$APP_DIR"
  HOST=127.0.0.1 PORT=8880 \
  VOICE_DESIGN_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign \
  VOICE_BASE_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-Base \
  TTS_DEVICE=cuda:0 TTS_ATTN=sdpa \
  PYTHONPATH="${QWEN_PYTHONPATH}${PYTHONPATH:+:$PYTHONPATH}" \
  "$TTS_DIR/.venv/bin/python" "$APP_DIR/voice_design_server.py" >"$TTS_LOG" 2>&1 &
  TTS_PID=$!
  wait_http "$TTS_URL/health" "$TTS_PID" "$TTS_LOG" "Qwen3-TTS"
fi

cd "$APP_DIR"
if [[ ! -d node_modules ]]; then npm install; fi

echo
echo "Application : http://127.0.0.1:3010"
echo "ComfyUI    : $COMFY_URL"
echo "Qwen3-TTS  : $TTS_URL"
echo
npm run start
