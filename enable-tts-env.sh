#!/usr/bin/env bash
set -euo pipefail
[[ -f .env ]] || cp .env.example .env
for line in 'TTS_URL=http://127.0.0.1:8880' 'TTS_MODEL=tts-1-hd-fr' 'TTS_LANGUAGE=French' 'TTS_API_KEY=sk-dummy-key' 'TTS_TIMEOUT_MS=600000'; do key="${line%%=*}"; grep -q "^${key}=" .env || echo "$line" >> .env; done
echo "Configuration TTS VoiceDesign présente dans .env"
