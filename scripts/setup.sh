#!/usr/bin/env bash
# One-shot dev setup: fetch/build every sidecar binary into src-tauri/binaries/.
#
# The binaries are NOT checked into git (they were ~150 MB of blobs and every
# refresh grew the history). A fresh clone runs this once, then `npm run
# tauri dev` works. Each sub-script is idempotent and enforces the
# self-contained-binary rule (otool -L guard — no /opt/homebrew, /usr/local,
# or /Users dylib references may ship).
#
# Sidecars assembled:
#   yt-dlp     — official single-file macOS static build   (download, ~40 MB)
#   ffmpeg     — osxexperts.net static arm64               (download, ~50 MB)
#   ffprobe    — martin-riedl.de static arm64              (download, ~60 MB)
#   whisper-cli         — built from whisper.cpp source    (compile, needs Xcode CLT)
#   saucebunny-diarize  — built from swift-sidecar/        (compile, needs Xcode CLT)
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
have() { [ -x "src-tauri/binaries/$1-aarch64-apple-darwin" ]; }

step "yt-dlp"
if have yt-dlp; then echo "already present — skipping (refresh: npm run refresh:sidecars)"; else bash scripts/refresh-sidecars.sh; fi

step "ffmpeg"
if have ffmpeg; then echo "already present — skipping (refresh: npm run refresh:ffmpeg)"; else bash scripts/fetch-ffmpeg.sh; fi

step "ffprobe"
if have ffprobe; then echo "already present — skipping (refresh: npm run refresh:ffprobe)"; else bash scripts/fetch-ffprobe.sh; fi

step "whisper-cli (compiles whisper.cpp — a few minutes on first run)"
if have whisper-cli; then echo "already present — skipping (rebuild: npm run build:whisper)"; else bash scripts/build-whisper.sh; fi

step "saucebunny-diarize (Swift sidecar)"
if have saucebunny-diarize; then echo "already present — skipping (rebuild: npm run build:diarizer)"; else bash scripts/build-diarizer.sh; fi

step "saucebunny-dictate (Swift sidecar — on-device voice dictation)"
if have saucebunny-dictate; then echo "already present — skipping (rebuild: npm run build:dictate)"; else bash scripts/build-dictate.sh; fi

step "llama-server (compiles llama.cpp — a few minutes; powers the AI Summary tab)"
if have llama-server; then echo "already present — skipping (rebuild: npm run build:llama)"; else bash scripts/build-llama.sh; fi

step "done"
ls -lh src-tauri/binaries/ | grep -v '^total\|\.gitkeep' || true
echo
echo "All sidecars ready. Next: npm run tauri dev"
