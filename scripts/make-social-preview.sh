#!/usr/bin/env bash
# Builds GitHub's link-card image from the README screenshot.
#
#   scripts/make-social-preview.sh [editors.png]     # default: docs/images/editors.png
#
# Writes docs/images/social-preview.png (1280x640, GitHub's recommended size). GitHub doesn't read it from the
# repo: upload it by hand under Settings > Social preview after it changes.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."

SHOT="${1:-docs/images/editors.png}"
OUT="docs/images/social-preview.png"
TAGLINE="Block and flowchart programming for the mBot, run on the robot"
BG="#11151d"    # the GUI's dark background; opaque, because link cards sit on light and dark pages alike

[[ -f "$SHOT" ]] || { echo "no screenshot at $SHOT" >&2; exit 1; }
command -v magick >/dev/null || { echo "needs ImageMagick (magick)" >&2; exit 1; }

# Fonts via fontconfig, so any sans works.
font() { fc-match -f '%{file}' "$1"; }
magick -size 1280x640 "xc:$BG" -gravity north \
    -font "$(font 'sans:bold')" -pointsize 76 -fill '#eef1f8' -annotate +0+40 'mbot-flow' \
    -font "$(font sans)" -pointsize 34 -fill '#a4adc0' -annotate +0+145 "$TAGLINE" \
    \( "$SHOT" -filter Lanczos -resize "1200x" \) -geometry +0+225 -composite \
    "$OUT"

echo "wrote $OUT ($(magick identify -format '%wx%h' "$OUT"))"
