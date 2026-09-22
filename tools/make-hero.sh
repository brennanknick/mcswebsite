#!/usr/bin/env bash
# ------------------------------------------------------------------
# Turn a gameplay recording into the homepage hero loop.
#
#   tools/make-hero.sh <recording.mp4> [start-seconds] [length-seconds]
#
#   e.g.  tools/make-hero.sh "C:/Users/brenn/Videos/match.mp4" 12 24
#
# Writes assets/video/hero.mp4 and assets/video/hero-poster.jpg.
# Then set heroVideo and heroPoster in site.config.js.
#
# What it does, and why:
#  - bakes in the look (blur, darken, a touch more saturation) the way
#    hoplite's hero video has its effects baked in. That keeps the page
#    free of a live CSS blur, which is expensive on a full-screen video.
#  - drops to 1280px wide: after the blur, extra pixels are invisible
#    and would only cost file size.
#  - crossfades the last second into the first, so the loop has no seam.
#  - strips audio (the hero is always muted).
# ------------------------------------------------------------------
set -euo pipefail

IN=${1:?usage: tools/make-hero.sh <recording> [start-seconds] [length-seconds]}
START=${2:-0}
LEN=${3:-20}          # whole seconds
FADE=1                # seconds of crossfade at the loop point
OUT=${OUT:-assets/video}

cd "$(dirname "$0")/.."

FF=ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
  FF="/c/Users/brenn/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0-full_build/bin/ffmpeg"
fi

if (( LEN < 3 * FADE )); then
  echo "length must be at least $((3 * FADE)) seconds" >&2
  exit 1
fi

mkdir -p "$OUT"

# sigma 6 at 1280px is hoplite's measured blur (7-9 at 1920) scaled down
LOOK="scale=1280:-2:flags=lanczos,gblur=sigma=6,eq=brightness=-0.14:contrast=0.92:saturation=1.1,fps=30,format=yuv420p"

# body = seconds FADE..LEN, head = seconds 0..FADE. Fading the head onto
# the end of the body means the last frame is (almost) the frame the loop
# restarts on.
"$FF" -v error -stats -y -ss "$START" -t "$LEN" -i "$IN" -an \
  -filter_complex "[0:v]${LOOK},split[a][b];[b]trim=0:${FADE},setpts=PTS-STARTPTS[head];[a]trim=${FADE}:${LEN},setpts=PTS-STARTPTS[body];[body][head]xfade=transition=fade:duration=${FADE}:offset=$((LEN - 2 * FADE))[v]" \
  -map "[v]" -c:v libx264 -preset slow -crf 30 -movflags +faststart \
  "$OUT/hero.mp4"

"$FF" -v error -y -i "$OUT/hero.mp4" -frames:v 1 -q:v 4 "$OUT/hero-poster.jpg"

echo
echo "Wrote $OUT/hero.mp4 ($(du -h "$OUT/hero.mp4" | cut -f1)) and $OUT/hero-poster.jpg"
echo "Now set in site.config.js:"
echo '  heroVideo: "assets/video/hero.mp4",'
echo '  heroPoster: "assets/video/hero-poster.jpg",'
