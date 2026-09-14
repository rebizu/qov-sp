#!/usr/bin/env bash
# capture_corpus.sh — Phase 0 scoreboard corpus capture (lossless FFV1).
#
# usage: ./capture_corpus.sh <output-dir> <seconds> [screen|cam|both]
#
# Sources (real footage, per the roadmap):
#   screen  full desktop scaled to 1280x720 @30 (gdigrab)  -> <dir>/screen720.mkv
#   camera  "Integrated Camera" scaled to 1280x720 @30     -> <dir>/cam720.mkv
#                                                    and    -> <dir>/cam360.mkv
# FFV1 level 3 intra-only = bit-exact ground truth for repeated scoreboard
# runs. Video only; audio corpus is Phase 3 scope.
set -euo pipefail

DIR="${1:?usage: capture_corpus.sh <output-dir> <seconds> [screen|cam|both]}"
SECS="${2:?usage: capture_corpus.sh <output-dir> <seconds> [screen|cam|both]}"
KIND="${3:-both}"
CAM="Integrated Camera"

mkdir -p "$DIR"

ffv1=( -c:v ffv1 -level 3 -g 1 -an )

case "$KIND" in
screen|both)
  echo "[capture] screen -> $DIR/screen720.mkv (${SECS}s)"
  ffmpeg -v error -y -f gdigrab -framerate 30 -i desktop \
    -t "$SECS" -vf scale=1280:720 "${ffv1[@]}" "$DIR/screen720.mkv"
  ;;
esac

case "$KIND" in
cam|both)
  echo "[capture] camera -> $DIR/cam720.mkv + cam360.mkv (${SECS}s)"
  ffmpeg -v error -y -f dshow -framerate 30 \
    -i "video=$CAM" -t "$SECS" -vf scale=1280:720 "${ffv1[@]}" "$DIR/cam720.mkv"
  ffmpeg -v error -y -i "$DIR/cam720.mkv" -vf scale=640:360 "${ffv1[@]}" "$DIR/cam360.mkv"
  ;;
esac
echo "[capture] done: $(ls -la "$DIR")"
