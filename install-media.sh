#!/usr/bin/env bash
set -Eeuo pipefail
sudo apt update
sudo apt install -y ffmpeg
ffmpeg -version | head -1
ffprobe -version | head -1
