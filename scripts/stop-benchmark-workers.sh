#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${DGX_BENCH_STATE_DIR:-$HOME/.dgx-avatar-benchmark}"
# Par sécurité, ne touche pas au worker principal 8188. Coupe seulement 8189-8191 lancés pour le benchmark.
for port in 8189 8190 8191; do
  pidfile="$STATE_DIR/pids/comfy-$port.pid"
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" && echo "Worker $port arrêté (PID $pid)"; fi
    rm -f "$pidfile"
  fi
done
