#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 ou plus récent est requis."); process.exit(1); }'
command -v ffmpeg >/dev/null
mkdir -p "$APP_DIR/.tools"
YOUTUBE_INSTALL_DIR="$(mktemp -d "$APP_DIR/.tools/yt-dlp-install.XXXXXX")"
trap 'rm -rf "$YOUTUBE_INSTALL_DIR"' EXIT
curl -fL --retry 2 --max-time 60 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$YOUTUBE_INSTALL_DIR/yt-dlp"
curl -fL --retry 2 --max-time 60 https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS -o "$YOUTUBE_INSTALL_DIR/SHA2-256SUMS"
python3 - "$YOUTUBE_INSTALL_DIR" <<'PY'
import hashlib
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
checksums = dict((line.split()[1].lstrip('*'), line.split()[0]) for line in (root / 'SHA2-256SUMS').read_text().splitlines() if line.strip())
if hashlib.sha256((root / 'yt-dlp').read_bytes()).hexdigest() != checksums.get('yt-dlp'):
    sys.exit('Échec de la vérification SHA-256 de yt-dlp.')
PY
chmod +x "$YOUTUBE_INSTALL_DIR/yt-dlp"
"$YOUTUBE_INSTALL_DIR/yt-dlp" --version
mv "$YOUTUBE_INSTALL_DIR/yt-dlp" "$APP_DIR/.tools/yt-dlp"
echo "Import YouTube installé dans $APP_DIR/.tools/yt-dlp"
