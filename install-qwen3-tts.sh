#!/usr/bin/env bash
set -Eeuo pipefail
TTS_DIR="${TTS_DIR:-$HOME/qwen3-tts}"
REPO="https://github.com/groxaxo/Qwen3-TTS-Openai-Fastapi.git"

echo "=== Installation Qwen3-TTS VoiceDesign pour DGX Spark ==="
echo "Destination: $TTS_DIR"
if [[ ! -d "$TTS_DIR/.git" ]]; then git clone "$REPO" "$TTS_DIR"; else git -C "$TTS_DIR" pull --ff-only; fi
cd "$TTS_DIR"
[[ -d .venv ]] || python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
python -m pip install torch --index-url https://download.pytorch.org/whl/cu130
python -m pip install -e ".[api]"

echo
echo "Le serveur v5 doit être lancé avec le checkpoint VoiceDesign:"
echo "  Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
echo "Il sera téléchargé automatiquement au premier lancement si nécessaire."
echo
echo "Commande manuelle:"
echo "  cd $TTS_DIR && source .venv/bin/activate"
echo "  HOST=127.0.0.1 PORT=8880 TTS_BACKEND=official TTS_MODEL_NAME=Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign ENABLE_VOICE_STUDIO=true python -m api.main"
