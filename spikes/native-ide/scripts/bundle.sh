#!/bin/bash
# Build NativeIDESpike.app (modelled on macos-app/scripts/bundle.sh): release build,
# Monaco copied into Resources/web/vs, Info.plist, ad-hoc signature.
#
#   scripts/bundle.sh   -> build/NativeIDESpike.app
#
# Run a benchmark:  build/NativeIDESpike.app/Contents/MacOS/NativeIDESpike --bench all --out r.json
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/NativeIDESpike.app"

./scripts/prepare-swiftterm.sh
if [ ! -d web/node_modules/monaco-editor ]; then (cd web && npm ci --silent); fi
(cd web && npm run --silent build)

build() { swift build -c release "$@"; }
# Same SDK fallback as macos-app. The spike is AppKit-only, so the newest CLT SDK works.
if ! build 2>build.log; then
  built=""
  for sdk in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX[0-9]*.*.sdk 2>/dev/null | sort -rV); do
    echo "Default SDK failed; trying $(basename "$sdk")"
    if SDKROOT="$sdk" build 2>build.log; then built=1; break; fi
  done
  [ -n "$built" ] || { cat build.log >&2; exit 1; }
fi
rm -f build.log
BINDIR="$(swift build -c release --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINDIR/NativeIDESpike" "$APP/Contents/MacOS/NativeIDESpike"
# SwiftTerm's resource bundle (Shaders.metal for the runtime-compiled Metal renderer)
cp -R "$BINDIR"/SwiftTerm_SwiftTerm.bundle "$APP/Contents/Resources/" 2>/dev/null || true
cp -R Resources/web "$APP/Contents/Resources/web"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.kunj.native-ide-spike</string>
  <key>CFBundleName</key><string>NativeIDESpike</string>
  <key>CFBundleExecutable</key><string>NativeIDESpike</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
echo "Built $APP"
