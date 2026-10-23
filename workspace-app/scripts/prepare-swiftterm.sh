#!/bin/bash
# Fetch SwiftTerm at an exact release into vendor/SwiftTerm and make it build with the
# Command Line Tools: SwiftTerm >= 1.12 lists Apple/Metal/Shaders.metal as a .process()
# resource, which needs the `metal` compiler that only Xcode ships. As a .copy() resource
# the source is bundled and MetalTerminalRenderer.makeLibrary() compiles it at runtime
# (its documented fallback). That one line is the only change.
#
# Safe to run from several agents/shells at once: the first takes a lock, the others wait.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=1.20.0
DIR=vendor/SwiftTerm
ready() { [ -f "$DIR/.kunj-version" ] && [ "$(cat "$DIR/.kunj-version")" = "$VERSION" ]; }
ready && exit 0
mkdir -p vendor
LOCK=vendor/.swiftterm.lock
for _ in $(seq 1 600); do
  if mkdir "$LOCK" 2>/dev/null; then break; fi
  ready && exit 0
  sleep 0.5
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
ready && exit 0
rm -rf "$DIR" "$DIR.tmp"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$VERSION" https://github.com/migueldeicaza/SwiftTerm "$DIR.tmp"
sed -i '' 's#\.process("Apple/Metal/Shaders.metal")#.copy("Apple/Metal/Shaders.metal")#' "$DIR.tmp/Package.swift"
grep -q '.copy("Apple/Metal/Shaders.metal")' "$DIR.tmp/Package.swift"
echo "$VERSION" > "$DIR.tmp/.kunj-version"
mv "$DIR.tmp" "$DIR"
echo "SwiftTerm $VERSION ready in $DIR (Shaders.metal patched to .copy)"
