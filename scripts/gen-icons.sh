#!/usr/bin/env bash
# Renders the app icons from assets/icon/kunj-icon.svg (64 px and up) and kunj-icon-small.svg (heavier
# strokes, 32 px and below) with headless Chrome, and writes:
#   macos-app/Resources/AppIcon.icns, workspace-app/Resources/AppIcon.icns  (tile at Apple's 824/1024 grid)
#   vscode-extension/media/icon.png                                        (128 px, full bleed)
#   docs-site/public/favicon.svg                                           (the small SVG)
# The outputs are committed, so building the apps does not need Chrome. Run it after changing an SVG.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "gen-icons: Chrome not found at $CHROME (set CHROME)" >&2; exit 1; }
BIG=assets/icon/kunj-icon.svg
SMALL=assets/icon/kunj-icon-small.svg
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# render <svg> <canvas px> <icon px> <out.png>: the icon drawn at <icon px>, centred on a transparent canvas
render() {
  cat > "$TMP/r.html" <<EOF
<html><body style="margin:0;background:transparent;display:grid;place-items:center;width:$2px;height:$2px"><img src="file://$PWD/$1" style="width:$3px;height:$3px"></body></html>
EOF
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$2,$2" --screenshot="$4" "file://$TMP/r.html" >/dev/null 2>&1
}

# macOS: the tile fills 824 of 1024 px, as Apple's icon grid has it, so it sits with other Dock icons
mkdir -p "$TMP/AppIcon.iconset"
for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x 128:icon_128x128 \
            256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  px="${spec%%:*}"; name="${spec#*:}"
  svg=$BIG; [ "$px" -le 32 ] && svg=$SMALL
  render "$svg" "$px" "$(( (px * 824 + 512) / 1024 ))" "$TMP/AppIcon.iconset/$name.png"
done
iconutil -c icns "$TMP/AppIcon.iconset" -o "$TMP/AppIcon.icns"
cp "$TMP/AppIcon.icns" macos-app/Resources/AppIcon.icns
cp "$TMP/AppIcon.icns" workspace-app/Resources/AppIcon.icns

render "$BIG" 128 128 vscode-extension/media/icon.png
mkdir -p docs-site/public
cp "$SMALL" docs-site/public/favicon.svg
echo "gen-icons: wrote AppIcon.icns (macos-app, workspace-app), vscode-extension/media/icon.png, docs-site/public/favicon.svg"
