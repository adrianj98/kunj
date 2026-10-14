#!/bin/bash
# Run the package's tests under the Command Line Tools.
#
# The newest SDK the Command Line Tools ship lacks the SwiftUI and Testing macro
# plugins, so use the 26.5 SDK (like bundle.sh's retry). After a failed compile the
# explicit-module caches can keep reporting "plugin for module 'TestingMacros' not
# found"; clearing them and retrying fixes that.
set -uo pipefail
cd "$(dirname "$0")/.."
export SDKROOT="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk}"

out="$(swift test "$@" 2>&1)"; status=$?
if [ $status -ne 0 ] && grep -q "plugin for module" <<<"$out"; then
  echo "Macro plugin not found; clearing module caches and retrying" >&2
  rm -rf .build/out
  out="$(swift test "$@" 2>&1)"; status=$?
fi
printf '%s\n' "$out"
exit $status
