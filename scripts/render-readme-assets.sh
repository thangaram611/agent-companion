#!/usr/bin/env bash
# render-readme-assets.sh — rasterize assets/readme/*.svg to the PNGs README embeds.
#
# The SVGs are the source; the PNGs are build output committed for GitHub, which
# does not render local SVG in Markdown reliably. Edit the SVG, run this, commit
# both. The previous drift — a diagram showing two companions long after the
# third shipped — is what this exists to make cheap to fix.
#
# Rasterizer: headless Chrome, because it is the one engine already on this
# machine that honours the CSS `font-family` stacks and `<style>` block the SVGs
# use. rsvg-convert ignores them and silently substitutes a default face.
#
# Usage:
#   bash scripts/render-readme-assets.sh            # render all
#   bash scripts/render-readme-assets.sh hero       # render one, by basename
#
# Override the browser with CHROME_BIN if it lives elsewhere.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/assets/readme"

CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ ! -x "$CHROME" ]; then
  for c in chromium google-chrome google-chrome-stable; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$(command -v "$c")"; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "render-readme-assets: no Chrome found; set CHROME_BIN" >&2; exit 2; }

# name:width:height — the PNG pixel size, which is 2x each SVG's viewBox.
ASSET_SPECS="
hero:3200:1800
architecture:3200:2220
target-matrix:3200:1700
"

render_one() {
  local name="$1" w="$2" h="$3"
  local svg="$ASSETS/$name.svg" png="$ASSETS/$name.png"
  [ -f "$svg" ] || { echo "  missing $svg" >&2; return 1; }

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  cp "$svg" "$tmp/in.svg"
  cat > "$tmp/page.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:${w}px;height:${h}px}</style>
<img src="in.svg">
HTML

  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=1 --window-size="${w},${h}" \
    --default-background-color=00000000 \
    --screenshot="$tmp/out.png" "$tmp/page.html" >/dev/null 2>&1

  [ -s "$tmp/out.png" ] || { echo "  render produced nothing for $name" >&2; return 1; }
  cp "$tmp/out.png" "$png"
  echo "  $name.svg -> $name.png (${w}x${h})"
}

want="${1:-}"
found=0
echo "$ASSET_SPECS" | while IFS=: read -r name w h; do
  [ -n "$name" ] || continue
  if [ -n "$want" ] && [ "$want" != "$name" ]; then continue; fi
  found=1
  render_one "$name" "$w" "$h"
done

if [ -n "$want" ] && ! echo "$ASSET_SPECS" | grep -q "^$want:"; then
  echo "render-readme-assets: unknown asset '$want'" >&2
  exit 2
fi
