#!/bin/bash
# Fetch the bundled fonts (SIL Open Font License) at pinned versions into Resources/fonts/:
# Inter 4.1 (Regular, Medium, SemiBold) and JetBrains Mono 2.304 (Regular, Medium), plus
# their licences. The app registers them through ATSApplicationFontsPath = fonts
# (Resources/Info.plist). Skips when every file is already there.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=Resources/fonts
FILES=(Inter-Regular.ttf Inter-Medium.ttf Inter-SemiBold.ttf Inter-LICENSE.txt
       JetBrainsMono-Regular.ttf JetBrainsMono-Medium.ttf JetBrainsMono-OFL.txt)
missing=""
for f in "${FILES[@]}"; do [ -f "$DEST/$f" ] || missing=1; done
[ -z "$missing" ] && exit 0

INTER_URL=https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
INTER_SHA=9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e
JBM_URL=https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
JBM_SHA=6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fetch() { # url sha out
  curl -fsSL -o "$3" "$1"
  local got; got="$(shasum -a 256 "$3" | cut -d' ' -f1)"
  if [ "$got" != "$2" ]; then echo "checksum mismatch for $1: $got" >&2; exit 1; fi
}
fetch "$INTER_URL" "$INTER_SHA" "$TMP/inter.zip"
fetch "$JBM_URL" "$JBM_SHA" "$TMP/jbm.zip"

mkdir -p "$DEST"
unzip -q -o -j "$TMP/inter.zip" extras/ttf/Inter-Regular.ttf extras/ttf/Inter-Medium.ttf extras/ttf/Inter-SemiBold.ttf -d "$DEST"
unzip -q -o -j "$TMP/inter.zip" LICENSE.txt -d "$TMP/inter" && cp "$TMP/inter/LICENSE.txt" "$DEST/Inter-LICENSE.txt"
unzip -q -o -j "$TMP/jbm.zip" fonts/ttf/JetBrainsMono-Regular.ttf fonts/ttf/JetBrainsMono-Medium.ttf -d "$DEST"
unzip -q -o -j "$TMP/jbm.zip" OFL.txt -d "$TMP/jbm" && cp "$TMP/jbm/OFL.txt" "$DEST/JetBrainsMono-OFL.txt"
echo "Fonts ready in $DEST"
