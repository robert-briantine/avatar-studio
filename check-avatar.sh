#!/usr/bin/env bash
set -euo pipefail
PORT="${PORT:-3010}"
echo "=== DGX Avatar Studio ==="
curl -fsS "http://127.0.0.1:${PORT}/api/status" | python3 -m json.tool
