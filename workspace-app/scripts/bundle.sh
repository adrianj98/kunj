#!/bin/bash
# Build "Kunj Workspace.app" from the Swift package: SwiftTerm (vendored, patched), Monaco
# (Resources/web/vs), the bundled fonts, a release build for arm64 and x86_64, the app bundle
# with Info.plist (__VERSION__ filled in) and SwiftTerm's resource bundle, ad-hoc signature.
#
#   scripts/bundle.sh                    -> build/Kunj Workspace.app
#   scripts/bundle.sh --install          -> also copies it to /Applications and launches it
#   SCRATCH=.build/me scripts/bundle.sh  own build dirs (--scratch-path <SCRATCH>/release-<arch>,
#                                        relative to workspace-app/), so parallel builds never wait
#   ARCHS=arm64 scripts/bundle.sh        one architecture (faster while iterating)
#   VERSION=1.4.0 scripts/bundle.sh      the version in Info.plist (default 0.1.0)
#
# Not notarized: on first launch macOS may refuse to open it; right-click > Open, or
#   xattr -dr com.apple.quarantine "/Applications/Kunj Workspace.app"
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${VERSION:-0.1.0}"
APP="build/Kunj Workspace.app"
INSTALL=""
[ "${1:-}" = "--install" ] && INSTALL=1

./scripts/prepare-swiftterm.sh
./scripts/fetch-fonts.sh
if [ ! -d web/node_modules/monaco-editor ]; then (cd web && npm install --silent --no-audit --no-fund); fi
(cd web && npm run --silent build)

# One build per architecture (--triple), joined with lipo. `--arch arm64 --arch x86_64` would
# switch SwiftPM to XCBuild, which also builds SwiftTerm's build-tool plugin for x86_64, and
# the Command Line Tools have no x86_64 compatibility libraries to link it with.
# Each architecture gets its own scratch dir (<SCRATCH>/release-<arch>): the build system
# writes every triple's products to the same out/Products/Release, so a shared one would
# leave two copies of the last architecture.
ARCH_LIST="${ARCHS:-arm64 x86_64}"
BASE="${SCRATCH:-.build}"
swift_build() { # arch, extra args...
  local a="$1"; shift
  swift build -c release --scratch-path "$BASE/release-$a" --triple "$a-apple-macosx14.0" "$@"
}
LOG="$BASE/bundle-build.log"
mkdir -p "$BASE"
: > "$LOG"
build_all() {
  for a in $ARCH_LIST; do swift_build "$a" >>"$LOG" 2>&1 || return 1; done
}

# Same SDK fallback as scripts/test.sh: some Command Line Tools SDKs fail to build; the one
# that worked is remembered per build dir.
SDK_FILE="$BASE/.kunj-sdk"
USER_SDK="${SDKROOT:-}"
if [ -z "$USER_SDK" ] && [ -f "$SDK_FILE" ] && [ -d "$(cat "$SDK_FILE")" ]; then export SDKROOT="$(cat "$SDK_FILE")"; fi
if ! build_all; then
  built=""
  if [ -z "$USER_SDK" ] && [ "$(xcode-select -p)" = "/Library/Developer/CommandLineTools" ]; then
    first="${SDKROOT:-}"
    for sdk in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX[0-9]*.*.sdk 2>/dev/null | sort -rV); do
      [ "$sdk" = "$first" ] && continue
      echo "Default SDK failed; trying $(basename "$sdk")"
      export SDKROOT="$sdk"
      if build_all; then built=1; echo "$sdk" > "$SDK_FILE"; break; fi
    done
  fi
  if [ -z "$built" ]; then grep -E "error:" "$LOG" | head -20 >&2; echo "Full log: $LOG" >&2; exit 1; fi
fi
bins=()
for a in $ARCH_LIST; do bins+=("$(swift_build "$a" --show-bin-path)"); done
BINDIR="${bins[0]}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
exes=()
for b in "${bins[@]}"; do exes+=("$b/KunjWorkspace"); done
lipo -create "${exes[@]}" -output "$APP/Contents/MacOS/KunjWorkspace"
sed "s/__VERSION__/$VERSION/g" Resources/Info.plist > "$APP/Contents/Info.plist"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# SwiftTerm's resource bundle (Shaders.metal for the runtime-compiled Metal renderer)
cp -R "$BINDIR"/SwiftTerm_SwiftTerm.bundle "$APP/Contents/Resources/" 2>/dev/null || true
cp -R Resources/web "$APP/Contents/Resources/web"
cp -R Resources/fonts "$APP/Contents/Resources/fonts"
codesign --force --sign "${CODESIGN_IDENTITY:--}" "$APP"
echo "Built $APP ($VERSION)"

if [ -n "$INSTALL" ]; then
  pkill -x KunjWorkspace 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x KunjWorkspace >/dev/null || break; sleep 0.2; done
  rm -rf "/Applications/Kunj Workspace.app"
  cp -R "$APP" /Applications/
  # open passes our environment on; the app hands it to every terminal, so drop a
  # terminal's colour settings
  env -u NO_COLOR -u FORCE_COLOR open "/Applications/Kunj Workspace.app"
  echo "Installed /Applications/Kunj Workspace.app"
fi
