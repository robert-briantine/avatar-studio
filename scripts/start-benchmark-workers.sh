#!/usr/bin/env bash
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/home/blockapicoder/comfyui-spark/ComfyUI}"
PYTHON="${COMFY_PYTHON:-/home/blockapicoder/comfyui-spark/comfyui-env/bin/python}"
COUNT="${1:-4}"
STATE_DIR="${DGX_BENCH_STATE_DIR:-$HOME/.dgx-avatar-benchmark}"
mkdir -p "$STATE_DIR/logs" "$STATE_DIR/pids"

if ! [[ "$COUNT" =~ ^[1-4]$ ]]; then echo "Usage: $0 [1|2|3|4]"; exit 2; fi
if [[ ! -f "$COMFY_DIR/main.py" ]]; then echo "ComfyUI introuvable: $COMFY_DIR"; exit 1; fi
if [[ ! -x "$PYTHON" ]]; then echo "Python ComfyUI introuvable: $PYTHON"; exit 1; fi

is_up(){ curl -fsS "http://127.0.0.1:$1/system_stats" >/dev/null 2>&1 || curl -fsS "http://127.0.0.1:$1/object_info" >/dev/null 2>&1; }

for i in $(seq 0 $((COUNT-1))); do
  port=$((8188+i))
  if is_up "$port"; then
    echo "[OK] worker $port déjà actif"
    continue
  fi
  echo "[START] ComfyUI worker $port"
  (
    cd "$COMFY_DIR"
    nohup "$PYTHON" main.py --listen 127.0.0.1 --port "$port" --disable-auto-launch --cache-none \
      >"$STATE_DIR/logs/comfy-$port.log" 2>&1 &
    echo $! >"$STATE_DIR/pids/comfy-$port.pid"
  )
done

for i in $(seq 0 $((COUNT-1))); do
  port=$((8188+i)); printf "Attente %s" "$port"
  for _ in $(seq 1 120); do
    if is_up "$port"; then echo " -> prêt"; break; fi
    printf "."; sleep 1
  done
  if ! is_up "$port"; then echo " -> ECHEC (voir $STATE_DIR/logs/comfy-$port.log)"; fi
done

echo
echo "Workers demandés: $COUNT"
echo "URLs: $(seq 0 $((COUNT-1)) | awk '{printf "%shttp://127.0.0.1:%d", (NR>1?",":""), 8188+$1}')"
echo "Benchmark UI: http://127.0.0.1:3000/benchmark.html"
