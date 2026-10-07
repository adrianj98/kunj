#!/bin/bash
# Build Kunj.app from the Swift package: release build, app bundle with
# Info.plist (LSUIElement, so no Dock icon), ad-hoc signature.
#
#   scripts/bundle.sh            -> build/Kunj.app
#   scripts/bundle.sh --install  -> also copies it to /Applications and launches it
#
# The app is not notarized. On first launch macOS may refuse to open it;
# right-click > Open, or: xattr -dr com.apple.quarantine /Applications/Kunj.app
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${VERSION:-0.1.0}"
APP="build/Kunj.app"

build() {
  swift build -c release --arch arm64 --arch x86_64 "$@"
}

# The Command Line Tools ship SDKs whose SwiftUI macros need a plugin only
# Xcode has. If the default SDK fails, retry with older installed SDKs.
if ! build 2>build.log; then
  built=""
  if [ "$(xcode-select -p)" = "/Library/Developer/CommandLineTools" ]; then
    for sdk in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX[0-9]*.*.sdk 2>/dev/null | sort -rV); do
      echo "Default SDK failed; trying $(basename "$sdk")"
      if SDKROOT="$sdk" build 2>build.log; then built=1; break; fi
    done
  fi
  if [ -z "$built" ]; then
    cat build.log >&2
    exit 1
  fi
fi
rm -f build.log

BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/KunjBar"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/KunjBar"
sed "s/__VERSION__/$VERSION/g" Resources/Info.plist > "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
echo "Built $APP ($VERSION)"

if [ "${1:-}" = "--install" ]; then
  pkill -x KunjBar 2>/dev/null || true
  # open fails (-600) if the old copy is still shutting down
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x KunjBar >/dev/null || break; sleep 0.2; done
  rm -rf /Applications/Kunj.app
  cp -R "$APP" /Applications/
  open /Applications/Kunj.app
  echo "Installed /Applications/Kunj.app"
fi
