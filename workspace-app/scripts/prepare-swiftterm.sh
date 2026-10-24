#!/bin/bash
# Fetch SwiftTerm at an exact release into vendor/SwiftTerm and make it build with the
# Command Line Tools: SwiftTerm >= 1.12 lists Apple/Metal/Shaders.metal as a .process()
# resource, which needs the `metal` compiler that only Xcode ships. As a .copy() resource
# the source is bundled and MetalTerminalRenderer.makeLibrary() compiles it at runtime
# (its documented fallback). The second change is in Pty.swift: the forked child closes
# every descriptor above 2 before execve, because forkpty does not, and a terminal tab must not
# hold the app's pipes (kunj events' stdin) or other tabs' PTY masters after the app is gone.
#
# Safe to run from several agents/shells at once: the first takes a lock, the others wait.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=1.20.0
# Bump the suffix when the patches change, so existing checkouts are fetched again
STAMP="$VERSION+kunj2"
DIR=vendor/SwiftTerm
ready() { [ -f "$DIR/.kunj-version" ] && [ "$(cat "$DIR/.kunj-version")" = "$STAMP" ]; }
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
perl -0pi -e 's/(\n(\s*)if pid == 0 \{\n)/$1$2    \/\/ kunj: keep only the terminal (0-2)\n$2    let kunjMaxFd = min(getdtablesize(), 65536)\n$2    var kunjFd: Int32 = 3\n$2    while kunjFd < kunjMaxFd { close(kunjFd); kunjFd += 1 }\n/' "$DIR.tmp/Sources/SwiftTerm/Pty.swift"
grep -q 'kunj: keep only the terminal' "$DIR.tmp/Sources/SwiftTerm/Pty.swift"
echo "$STAMP" > "$DIR.tmp/.kunj-version"
mv "$DIR.tmp" "$DIR"
echo "SwiftTerm $VERSION ready in $DIR (Shaders.metal patched to .copy, child descriptors closed)"
