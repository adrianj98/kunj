#!/bin/bash
# Fetch SwiftTerm at an exact release into vendor/SwiftTerm and make it build with the
# Command Line Tools: SwiftTerm >= 1.12 lists Apple/Metal/Shaders.metal as a .process()
# resource, which needs the `metal` compiler that only Xcode ships. As a .copy() resource
# the source is bundled and MetalTerminalRenderer.makeLibrary() compiles it at runtime
# (its documented fallback). That one line is the only change.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=1.20.0
DIR=vendor/SwiftTerm
if [ -f "$DIR/.spike-version" ] && [ "$(cat "$DIR/.spike-version")" = "$VERSION" ]; then exit 0; fi
rm -rf "$DIR"
git clone --quiet --depth 1 --branch "v$VERSION" https://github.com/migueldeicaza/SwiftTerm "$DIR"
sed -i '' 's#\.process("Apple/Metal/Shaders.metal")#.copy("Apple/Metal/Shaders.metal")#' "$DIR/Package.swift"
grep -q '.copy("Apple/Metal/Shaders.metal")' "$DIR/Package.swift"
echo "$VERSION" > "$DIR/.spike-version"
echo "SwiftTerm $VERSION ready in $DIR (Shaders.metal patched to .copy)"
