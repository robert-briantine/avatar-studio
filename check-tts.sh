#!/usr/bin/env bash
set -euo pipefail
TTS_URL="${TTS_URL:-http://127.0.0.1:8880}"; TTS_URL="${TTS_URL%/}"
echo "Qwen3-TTS: $TTS_URL"
if ! curl -fsS --max-time 3 "$TTS_URL/health" >/dev/null 2>&1; then echo "ERREUR: /health ne répond pas"; exit 1; fi
echo "OK: serveur joignable"
echo "Modèles déclarés:"
curl -fsS --max-time 5 "$TTS_URL/v1/models" || true
echo
echo "La v4 attend Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign côté serveur."
