#!/usr/bin/env bash
# Synthetic moving picture + isolated stereo tones; no user media or capture.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
[[ $# == 1 && "$1" = /* && ! -e "$1" ]] || {
  echo 'usage: make-obs-test-fixture.sh <new-absolute-output.mp4>' >&2; exit 2;
}
"$project_root/src-tauri/binaries/ffmpeg-aarch64-apple-darwin" -hide_banner -loglevel error -n \
  -f lavfi -i 'testsrc2=size=1280x720:rate=24:duration=12' \
  -f lavfi -i 'aevalsrc=0.04*sin(2*PI*440*t)|0.04*sin(2*PI*660*t):s=48000:d=12:c=stereo' \
  -map 0:v:0 -map 1:a:0 -t 12 -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart -f mp4 "$1"
