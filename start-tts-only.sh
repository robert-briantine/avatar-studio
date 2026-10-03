#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
TTS_DIR="${TTS_DIR:-/home/blockapicoder/qwen3-tts}"
TTS_OFFICIAL_DIR="${TTS_OFFICIAL_DIR:-/home/blockapicoder/qwen3-tts-official}"
TTS_URL="${TTS_URL:-http://127.0.0.1:8880}"
TTS_LOG="${TTS_LOG:-/tmp/qwen3-tts-dgx.log}"

if curl -fsS --max-time 2 "$TTS_URL/health" >/dev/null 2>&1; then
  exit 0
fi

if [[ ! -x "$TTS_DIR/.venv/bin/python" ]]; then
  echo "Environnement Qwen3-TTS absent: $TTS_DIR/.venv/bin/python" >&2
  exit 2
fi

if [[ -d "$TTS_OFFICIAL_DIR/qwen_tts" ]]; then
  QWEN_PYTHONPATH="$TTS_OFFICIAL_DIR"
else
  QWEN_PYTHONPATH=""
fi

cd "$APP_DIR"

nohup env \
  HOST=127.0.0.1 \
  PORT=8880 \
  VOICE_DESIGN_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign \
  VOICE_BASE_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-Base \
  TTS_DEVICE=cuda:0 \
  TTS_ATTN=sdpa \
  PYTHONPATH="${QWEN_PYTHONPATH}${PYTHONPATH:+:$PYTHONPATH}" \
  "$TTS_DIR/.venv/bin/python" "$APP_DIR/voice_design_server.py" \
  >>"$TTS_LOG" 2>&1 </dev/null &

for _ in {1..120}; do
  if curl -fsS --max-time 2 "$TTS_URL/health" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "Le serveur TTS n'a pas redémarré. Voir $TTS_LOG" >&2
exit 3
